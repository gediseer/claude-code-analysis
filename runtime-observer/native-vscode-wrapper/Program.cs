using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace ClaudeObserverWrapper
{
    internal static class Program
    {
        private const string RequiredEndpoint = "http://127.0.0.1:33333/api/anthropic";
        private const uint JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            uint informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll")]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private static int Main(string[] args)
        {
            if (args.Length == 0 || !Path.IsPathRooted(args[0]))
            {
                Console.Error.WriteLine("The Claude Code extension must pass its bundled binary as the wrapper's first argument.");
                return 64;
            }

            var realExecutable = args[0];
            var forwardedArguments = args.Skip(1).ToArray();
            var auditDirectory = Environment.GetEnvironmentVariable("CLAUDE_OBSERVER_AUDIT_DIR");
            var routingSettings = Environment.GetEnvironmentVariable("CLAUDE_OBSERVER_ROUTING_SETTINGS");
            if (String.IsNullOrWhiteSpace(auditDirectory) || !Path.IsPathRooted(auditDirectory))
            {
                Console.Error.WriteLine("CLAUDE_OBSERVER_AUDIT_DIR must name an absolute audit directory.");
                return 64;
            }
            if (String.IsNullOrWhiteSpace(routingSettings) || !Path.IsPathRooted(routingSettings) || !File.Exists(routingSettings))
            {
                Console.Error.WriteLine("CLAUDE_OBSERVER_ROUTING_SETTINGS must name the endpoint-only settings overlay.");
                return 64;
            }
            if (!String.Equals(Environment.GetEnvironmentVariable("CLAUDE_CODE_ENTRYPOINT"), "claude-vscode", StringComparison.Ordinal))
            {
                Console.Error.WriteLine("Observer routing guard requires the native claude-vscode entrypoint.");
                return 78;
            }

            Directory.CreateDirectory(auditDirectory);
            var wrapperPid = Process.GetCurrentProcess().Id;
            WriteAuditRecord(
                Path.Combine(auditDirectory, "launch-" + wrapperPid + ".json"),
                new Dictionary<string, object>
                {
                    { "schemaVersion", 1 },
                    { "wrapperPid", wrapperPid },
                    { "startedAt", DateTime.UtcNow.ToString("o") },
                    { "cwd", Environment.CurrentDirectory },
                    { "realExecutable", realExecutable },
                    { "args", forwardedArguments },
                    { "endpoint", RequiredEndpoint },
                    { "entrypoint", Environment.GetEnvironmentVariable("CLAUDE_CODE_ENTRYPOINT") ?? "" },
                    { "routingSettings", routingSettings }
                });

            var childArguments = forwardedArguments.Concat(new[] { "--settings", routingSettings }).ToArray();
            var startInfo = new ProcessStartInfo
            {
                FileName = realExecutable,
                Arguments = JoinWindowsArguments(childArguments),
                UseShellExecute = false,
                WorkingDirectory = Environment.CurrentDirectory,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            startInfo.EnvironmentVariables["ANTHROPIC_BASE_URL"] = RequiredEndpoint;
            startInfo.EnvironmentVariables.Remove("CLAUDE_OBSERVER_AUDIT_DIR");
            startInfo.EnvironmentVariables.Remove("CLAUDE_OBSERVER_ROUTING_SETTINGS");

            using (var child = Process.Start(startInfo))
            {
                if (child == null)
                {
                    Console.Error.WriteLine("Failed to start the bundled Claude Code binary.");
                    return 70;
                }
                var job = CreateKillOnCloseJob(child);
                WriteAuditRecord(
                    Path.Combine(auditDirectory, "child-" + wrapperPid + ".json"),
                    new Dictionary<string, object>
                    {
                        { "schemaVersion", 1 },
                        { "wrapperPid", wrapperPid },
                        { "childPid", child.Id },
                        { "recordedAt", DateTime.UtcNow.ToString("o") }
                    });

                var stdin = Task.Run(async delegate
                {
                    try
                    {
                        await PumpAndFlushAsync(
                            Console.OpenStandardInput(),
                            child.StandardInput.BaseStream).ConfigureAwait(false);
                        child.StandardInput.Close();
                    }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                });
                var stdout = PumpAndFlushAsync(
                    child.StandardOutput.BaseStream,
                    Console.OpenStandardOutput());
                var stderr = PumpAndFlushAsync(
                    child.StandardError.BaseStream,
                    Console.OpenStandardError());
                try
                {
                    child.WaitForExit();
                    Task.WaitAll(new[] { stdout, stderr });
                    GC.KeepAlive(stdin);
                    return child.ExitCode;
                }
                finally
                {
                    CloseHandle(job);
                }
            }
        }

        private static IntPtr CreateKillOnCloseJob(Process child)
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                child.Kill();
                throw new InvalidOperationException("Failed to create the Observer child-process job.");
            }
            var information = new ExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
            var pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, pointer, false);
                if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    pointer,
                    (uint)size) ||
                    !AssignProcessToJobObject(job, child.Handle))
                {
                    child.Kill();
                    CloseHandle(job);
                    throw new InvalidOperationException(
                        "Failed to bind the Observer child process to its lifecycle job.");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
            return job;
        }

        private static async Task PumpAndFlushAsync(Stream source, Stream destination)
        {
            var buffer = new byte[16 * 1024];
            while (true)
            {
                var bytesRead = await source.ReadAsync(
                    buffer, 0, buffer.Length).ConfigureAwait(false);
                if (bytesRead == 0) return;
                await destination.WriteAsync(
                    buffer, 0, bytesRead).ConfigureAwait(false);
                await destination.FlushAsync().ConfigureAwait(false);
            }
        }

        private static string JoinWindowsArguments(IEnumerable<string> arguments)
        {
            return String.Join(" ", arguments.Select(QuoteWindowsArgument));
        }

        private static string QuoteWindowsArgument(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return argument;
            }
            var result = new StringBuilder();
            result.Append('"');
            var backslashes = 0;
            foreach (var character in argument)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static void WriteAuditRecord(string filePath, IDictionary<string, object> values)
        {
            var parts = values.Select(pair => "  \"" + JsonEscape(pair.Key) + "\": " + JsonValue(pair.Value));
            File.WriteAllText(filePath, "{\r\n" + String.Join(",\r\n", parts) + "\r\n}\r\n", new UTF8Encoding(false));
        }

        private static string JsonValue(object value)
        {
            if (value == null) return "null";
            var strings = value as string[];
            if (strings != null) return "[" + String.Join(",", strings.Select(item => "\"" + JsonEscape(item) + "\"")) + "]";
            if (value is string) return "\"" + JsonEscape((string)value) + "\"";
            if (value is int) return ((int)value).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return "\"" + JsonEscape(value.ToString()) + "\"";
        }

        private static string JsonEscape(string value)
        {
            var result = new StringBuilder();
            foreach (var character in value ?? "")
            {
                switch (character)
                {
                    case '\\': result.Append("\\\\"); break;
                    case '"': result.Append("\\\""); break;
                    case '\r': result.Append("\\r"); break;
                    case '\n': result.Append("\\n"); break;
                    case '\t': result.Append("\\t"); break;
                    default:
                        if (character < 0x20) result.Append("\\u" + ((int)character).ToString("x4"));
                        else result.Append(character);
                        break;
                }
            }
            return result.ToString();
        }
    }
}
