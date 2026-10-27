# Security

Hoodsfield runs on your own PC and talks to your own ComfyUI. Nothing is sent to a cloud service by the app itself. This page says what it does expose and how to keep it safe.

## What listens on the network

- The studio listens on port **8000** on all interfaces so a phone on your home network can open it. Requests from this PC, your private network and Tailscale are trusted. If you do not want that, block port 8000 in the Windows firewall (the optional `Phone_Access_Setup.bat` is what opens it for the private profile).
- **Internet access is off by default.** `Remote_Access.bat` starts a Cloudflare quick tunnel and refuses to do so until a login is set (Settings → Remote access, or `Set_Remote_Password.bat`). Anything arriving through the tunnel must sign in; the password is stored salted and hashed, repeated failures are locked out for a few minutes.
- ComfyUI itself is started on `127.0.0.1` only.

## Things that can only be done on the PC itself

Settings refuses these from any other device (phone, LAN or tunnel): signing in or out of Claude, saving an API key, changing the ComfyUI folder, extra model folders, start-up options and the work folder, setting the remote password, installing the Claude Code skill and restarting the studio.

## Secrets

- `app/backend/hoodsfield_settings.json` (settings, including an optional Anthropic API key) and `app/backend/hf_auth.json` (remote login hash) are git-ignored. Do not commit them.
- By default the Assistant signs in with your own Claude account and **no API key is stored**. If you choose the API-key method the key is kept in the settings file in plain text, readable by anyone with access to your user account, so prefer the account sign-in on shared PCs.
- Diagnostics (`Copy diagnostics`) never include keys or passwords.

## The Assistant's permissions

The Assistant is a headless Claude Code session started with `--tools Read` and an allow-list that contains only Hoodsfield's own tools. It cannot run shell commands, write files or browse the web.

## Reporting a problem

Please open a GitHub issue for ordinary bugs. For a security problem, use GitHub's **Report a vulnerability** (Security tab) so it is not public before it is fixed.
