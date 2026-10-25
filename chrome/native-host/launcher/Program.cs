using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DiscordDirectNativeHost;

internal sealed record HostSettings(
    [property: JsonPropertyName("allowedOrigin")] string AllowedOrigin,
    [property: JsonPropertyName("nodeExecutable")] string NodeExecutable);

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var baseDirectory = AppContext.BaseDirectory;
        var settingsPath = Path.Combine(baseDirectory, "host-settings.json");
        HostSettings? settings;
        try
        {
            settings = JsonSerializer.Deserialize<HostSettings>(await File.ReadAllTextAsync(settingsPath));
        }
        catch
        {
            Console.Error.WriteLine("Discord Direct helper configuration could not be read.");
            return 2;
        }

        if (settings is null || args.Length == 0 || args[0] != settings.AllowedOrigin ||
            !settings.AllowedOrigin.StartsWith("chrome-extension://", StringComparison.Ordinal) ||
            !File.Exists(settings.NodeExecutable))
        {
            Console.Error.WriteLine("Discord Direct helper rejected the caller or Node.js path.");
            return 3;
        }

        var hostScript = Path.Combine(baseDirectory, "host.cjs");
        if (!File.Exists(hostScript))
        {
            Console.Error.WriteLine("Discord Direct helper script is missing.");
            return 4;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = settings.NodeExecutable,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = baseDirectory,
        };
        startInfo.ArgumentList.Add(hostScript);
        startInfo.ArgumentList.Add(settings.AllowedOrigin);

        using var child = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        try
        {
            if (!child.Start()) return 5;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Discord Direct helper could not start Node.js: {error.Message}");
            return 5;
        }

        using var cancellation = new CancellationTokenSource();
        var inputTask = PumpInputAsync(child, cancellation.Token);
        var outputTask = PumpOutputAsync(child);
        var errorTask = PumpErrorAsync(child);
        var childExitTask = child.WaitForExitAsync();
        var firstCompleted = await Task.WhenAny(childExitTask, inputTask);
        if (firstCompleted == childExitTask)
        {
            // A failed Node startup must close the native host promptly. Waiting for the
            // browser's stdin pipe here can keep the host alive after its child has exited.
            cancellation.Cancel();
            try { child.StandardInput.Close(); } catch (IOException) { }
        }
        else
        {
            await inputTask;
        }

        await childExitTask;
        await Task.WhenAll(outputTask, errorTask);
        return child.ExitCode;
    }

    private static async Task PumpInputAsync(Process child, CancellationToken cancellationToken)
    {
        try
        {
            await Console.OpenStandardInput().CopyToAsync(
                child.StandardInput.BaseStream,
                81920,
                cancellationToken);
            await child.StandardInput.BaseStream.FlushAsync();
        }
        catch (Exception error) when (
            error is IOException or OperationCanceledException or ObjectDisposedException)
        {
            // Chrome can close the native host pipe while the helper is exiting.
        }
        finally
        {
            try { child.StandardInput.Close(); } catch (Exception error) when (error is IOException or ObjectDisposedException) { }
        }
    }

    private static async Task PumpOutputAsync(Process child)
    {
        try
        {
            await child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            await Console.OpenStandardOutput().FlushAsync();
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // The extension closed its Native Messaging port.
        }
    }

    private static async Task PumpErrorAsync(Process child)
    {
        try
        {
            await child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            await Console.OpenStandardError().FlushAsync();
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // Native Messaging diagnostics are best effort only.
        }
    }
}
