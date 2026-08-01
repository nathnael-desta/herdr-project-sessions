# Contributing

## Setup

Requirements are the same as the plugin's runtime requirements: Linux, Herdr
`0.7.0` or newer, Node.js, and Git. No package installation is required.

Link a checkout while developing:

```bash
herdr plugin link /path/to/herdr-project-sessions
```

Open the plugin with:

```bash
herdr plugin pane open \
  --plugin nate.project-sessions \
  --entrypoint browser \
  --placement overlay \
  --focus
```

## Checks

Run these commands before submitting changes:

```bash
node --check src/browser.js
node src/browser.js --dump
herdr config check
```

For archive changes, use a temporary state directory so local archive data is
not modified:

```bash
HERDR_PLUGIN_STATE_DIR=/tmp/herdr-project-sessions-state node src/browser.js --dump
```

Interactive changes should be tested in a real Herdr pane. Check keyboard
navigation, mouse selection, live-session focusing, settled-session resuming,
refreshing, and archive/unarchive behavior when those areas are affected.

## Pull Requests

- Keep changes focused and avoid adding runtime dependencies without a clear need.
- Update `README.md` when controls, requirements, or user-visible behavior change.
- Update `herdr-plugin.toml` when the plugin ID, version, entrypoint, or minimum Herdr version changes.
- Include the checks you ran and any provider-specific limitations.
- Do not include local session databases, archive state, credentials, or machine-specific paths in commits.
