# Codex Chat for Obsidian

Codex Chat is a desktop-only Obsidian community plugin for chatting with Codex, continuing local sessions, and reviewing earlier conversations without leaving Obsidian. It renders message Markdown through Obsidian's `MarkdownRenderer`, so Obsidian's normal Markdown and MathJax handling is used for headings, tables, code, and LaTeX.

## Scope and security

- Windows and macOS desktop are the primary targets. Mobile is not supported.
- The plugin can start Codex CLI through `@openai/codex-sdk` and send prompts from the chat composer. It does not read or store API keys itself; authentication and model/provider configuration remain managed by Codex CLI.
- History remains local. The plugin adds no telemetry and does not upload vault contents or history.
- History text is passed to `MarkdownRenderer`; it is not inserted as raw HTML and does not execute JavaScript from a history file.
- The plugin validates the selected working directory before reading history and does not write outside Obsidian's settings storage.

## Installation

Build the plugin, then copy `main.js`, `manifest.json`, and `styles.css` to `<Vault>/.obsidian/plugins/obsidian-codex-chat/`, reload Obsidian, and enable **Codex Chat** in **Settings → Community plugins**.

## Development

```bash
pnpm install
pnpm run dev
pnpm test
pnpm run lint
pnpm run build
```

## Working directory

Open **Open Codex Chat** from the Command Palette or the ribbon. Choose a working directory, start a new conversation, or continue a session from the session list. The view accepts an absolute path, can use the local vault root, and can use the parent directory of the active file. The default can also be configured in **Settings → Codex Chat**.

## History discovery and formats

The local provider first checks the optional manually configured location, then (when enabled) checks `CODEX_HOME`, `%USERPROFILE%/.codex`, `$HOME/.codex`, and common Windows AppData candidates. It recursively scans Codex `sessions` and `archived_sessions` locations for `rollout-*.jsonl`, plus explicitly selected JSON/JSONL files.

Current [Codex rollout source](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs) and [Codex documentation discussion](https://github.com/openai/codex/discussions/12668) describe rollout files as local JSONL records under the Codex home and show `session_meta`, `event_msg`, and `response_item` records. There is no stable public SDK history-enumeration API used by this plugin, so the provider deliberately reads those local files and isolates format assumptions in `src/parsers/CodexHistoryParser.ts`. The parser supports JSON, JSONL, and NDJSON-style records, tolerates malformed lines, and preserves unknown event payloads as `unknown` where possible.

The Codex rollout format and paths may change between Codex releases. If a session format changes, update the parser/provider only; the views use the normalized interfaces in `src/types/codex.ts`. A mock provider is included for UI and parser development.

## Known constraints

- Sessions are associated with a working directory only when the rollout contains cwd metadata. An explicitly selected file can still be inspected without cwd metadata.
- SQLite state databases and Codex's session index are not used as authoritative transcript sources in this version. Rollout JSONL is preferred because it contains the conversation body and avoids an SQLite native dependency.
- Very large rollouts are capped by the configurable maximum message count. Individual unreadable files are reported without stopping the rest of the scan.
- Chat sending uses the Codex SDK's local CLI process. A thread can be continued while the view is open, and the existing rollout provider remains responsible for history browsing. Streaming events, approvals, richer command output, note context, and Markdown export remain future extensions.

## Architecture

`CodexHistoryProvider` is the stable boundary for future SDK or app-server adapters. `LocalCodexHistoryProvider` handles filesystem discovery and file errors, `CodexHistoryParser` normalizes changing rollout records, `CodexHistoryService` owns loading, and the views/components render only normalized Codex types.

---

The remainder of this file contains the upstream Obsidian template notes for contributors.

This is a sample plugin for Obsidian (https://obsidian.md).

This project uses TypeScript to provide type checking and documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript Definition format, which contains TSDoc comments describing what it does.

This sample plugin demonstrates some of the basic functionality the plugin API can do.

- Adds a ribbon icon, which shows a Notice when clicked.
- Adds a command "Open modal (simple)" which opens a Modal.
- Adds a plugin setting tab to the settings page.
- Registers a global click event and outputs a Notice on click.
- Registers a global interval which logs 'setInterval' to the console.

## First time developing plugins?

Quick starting guide for new plugin devs:

- Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
- Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
- Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
- Install NodeJS, then run `pnpm install` in the command line under your repo folder.
- Run `pnpm run dev` to compile your plugin from `src/main.ts` to `main.js`.
- Make changes to `src/main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
- Reload Obsidian to load the new version of your plugin.
- Enable plugin in settings window.
- For updates to the Obsidian API run `pnpm update` in the command line under your repo folder.

## Releasing new releases

- Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
- Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
- Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
- Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
- Publish the release.

> You can simplify the version bump process by running `pnpm version patch`, `pnpm version minor` or `pnpm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

- Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Publish an initial version.
- Make sure you have a `README.md` file in the root of your repo.
- Make a pull request at https://github.com/obsidianmd/obsidian-releases to add your plugin.

## How to use

- Clone this repo.
- Make sure your NodeJS is at least v18 (`node --version`).
- `pnpm install` to install dependencies.
- `pnpm run dev` to start compilation in watch mode.

## Manually installing the plugin

- Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Improve code quality with eslint

- [ESLint](https://eslint.org/) is a tool that analyzes your code to quickly find problems. You can run ESLint against your plugin to find common bugs and ways to improve your code.
- This project already has eslint preconfigured, you can invoke a check by running `pnpm run lint`
- Together with a custom eslint [plugin](https://github.com/obsidianmd/eslint-plugin) for Obsidan specific code guidelines.
- A GitHub action is preconfigured to automatically lint every commit on all branches.

## Funding URL

You can include funding URLs where people who use your plugin can financially support it.

The simple way is to set the `fundingUrl` field to your link in your `manifest.json` file:

```json
{
	"fundingUrl": "https://buymeacoffee.com"
}
```

If you have multiple URLs, you can also do:

```json
{
	"fundingUrl": {
		"Buy Me a Coffee": "https://buymeacoffee.com",
		"GitHub Sponsor": "https://github.com/sponsors",
		"Patreon": "https://www.patreon.com/"
	}
}
```

## API Documentation

See https://docs.obsidian.md
