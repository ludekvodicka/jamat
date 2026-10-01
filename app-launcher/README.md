# Jamat Launcher

One independently running Windows agent starts one explicitly configured Jamat profile. It reports
readiness through the existing local AppClientUI API; it does not manage sessions or access AppHost.

Windows Jamat installers include Autolauncher in `resources/launcher`, with its own Node runtime,
installer and licenses. Enable Autolauncher in Jamat Settings to register the current executable and
profile. The installed launcher runs from its own release under `%LOCALAPPDATA%/JamatLauncher`,
independently of Jamat.
Source installations register the checkout's `scripts/release/start-packaged-client.ts` instead.
That helper packages changed source in an isolated snapshot and starts the selected EXE with the
same profile and runtime channel. A failed build fails the start request instead of starting an older EXE.

Build on the Jamat development machine:

```powershell
pnpm setup:remarkable-sidecar
pnpm release:launcher
```

This preparation also runs before desktop packaging. It reuses the pinned Node 22.23.2 runtime
prepared for the current build platform; it does not download another runtime or require one on
the target Windows PC. macOS and Linux release builds include their platform runtime, but automatic
launcher installation is available only on Windows.

To install on either PC:

1. Open the MiniWol web page and choose **Nastavit spouštění Jamatu** for that PC.
2. Copy its one-time invitation into **Settings > Autolauncher** in the Jamat you want to start remotely.
3. Check the captured profile and path, choose **Enable for this Jamat**, and approve Windows UAC
   using the same Windows account. No manual PowerShell command is required.

If UAC is cancelled, use **Retry with saved connection**. **Update for this Jamat** updates the
independent runtime and captured path. Replacing another profile is explicitly labelled. **Disable**
removes the owning profile's task and firewall rule while retaining pairing for a later setup.

The configuration contains `publicUrl` (HTTP LAN IPv4 origin), `key` (64 hexadecimal characters),
`configDir`, `configIdentity`, `runtimeChannel`, `logFile`, and `recipe`. Existing identity and channel
must match. The executable recipe is `{ "kind": "executable", "path": "C:/.../Jamat.exe" }`.
The source-build recipe is `{ "kind": "source", "repositoryRoot": "C:/.../Jamat" }`.
The launcher uses its own Node runtime with the checkout's `node_modules/tsx/dist/cli.mjs` and
`scripts/release/start-packaged-client.ts` as separate arguments. The working directory is the
checkout root, and the checkout must already have its development dependencies installed.
Existing `command` recipes remain supported. A Windows `cmd.exe /d /s /c` recipe carries its quoted command line explicitly and sets
`windowsVerbatimArguments: true`, so Node does not escape cmd's quotes as C-runtime arguments.
No HTTP caller can alter the recipe.

Settings supplies absolute paths from the current application and verifies its existing identity.
The installer runs under the same Windows SID, serializes setup, validates task/rule ownership, and
copies each runtime into a separate `releases/<id>` directory. Updates pause new remote starts and
refuse an ongoing startup. They leave existing Jamat and Host processes running.

The runtime is included, so an installed-EXE PC needs no system Node or build tools. The logon task
uses the existing user desktop, including sleep/resume. It does not work before Windows login.
Windows setup creates the inbound TCP firewall rule limited to the MiniWolService gateway.
The web service and unencrypted invitation exchange are intended for the trusted LAN.

Run development checks from the repository root with `pnpm typecheck` and `pnpm test`.
