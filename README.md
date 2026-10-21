# pi-model-decider

A [Pi](https://pi.dev) extension that uses a classifier to select a model and thinking level from natural-language hints.

**Experimental.** Selection accuracy and optimality are not guaranteed. Classifier and model calls may incur API charges. Automatic selection is disabled by default.

## Requirements

- Pi 1.2.x (tested with 1.2.0)
- A classifier and execution models registered and authenticated in Pi
- Node.js 22.18 or later when developing the package

## Install

Install directly from GitHub:

```sh
pi install git:github.com/yshrkt/pi-model-decider
```

For local development, install from your checkout:

```sh
pi install ./path/to/pi-model-decider
```

## Configure

Create `~/.pi/agent/extensions/pi-model-decider/config.json`:

```json
{
  "enabled": false,
  "classifier": {
    "provider": "typesafe",
    "model": "jev-latest",
    "timeoutMs": 5000
  },
  "selectionHint": "Keep the current profile when sufficient. Use deep for complex design or debugging.",
  "mode": "selective",
  "profiles": [
    {
      "id": "standard",
      "model": { "provider": "your-provider", "id": "your-model" },
      "thinking": "medium",
      "hint": "Routine implementation, fixes, and questions.",
      "ask": false
    },
    {
      "id": "deep",
      "model": { "provider": "your-provider", "id": "your-model" },
      "thinking": "high",
      "hint": "Complex design, difficult debugging, and careful analysis.",
      "ask": true
    }
  ]
}
```

Replace the classifier and model references with IDs from your Pi configuration. Each model must support its profile's thinking level. A copyable configuration is available in [config.example.json](config.example.json).

| Field           | Default            | Description                                                                                               |
| --------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `enabled`       | `false`            | Enable automatic selection                                                                                |
| `classifier`    | required to enable | Classifier `provider` and `model`; `timeoutMs` defaults to `5000`                                         |
| `selectionHint` | `""`               | Shared selection instructions                                                                             |
| `mode`          | `"ask"`            | `auto`: no confirmation; `ask`: confirm every change; `selective`: follow the destination profile's `ask` |
| `profiles`      | required to enable | Unique IDs with a model, thinking level, hint, and optional `ask` (default `true`)                        |

Profiles may share a model with different thinking levels. Duplicate model/thinking combinations are rejected. Restart Pi or run `/reload` after editing the file.

## Use

```text
/model-decider on
/model-decider status
/model-decider off
```

On/off changes are saved to `config.json` and take effect only after a successful save. The file must already exist. Turning selection off keeps the current model and thinking level.

Selection runs once per user request and stays fixed through tool calls, retries, and steering. Confirmation offers **Approve**, **Reject**, and **Reselect**. Rejecting or closing the dialog keeps the current selection; reselect excludes previous proposals for that request and appears only when at least two alternatives remain. Thinking-only changes follow the same confirmation rules. Changes requiring confirmation are rejected when no dialog UI is available.

Invalid responses, classifier errors, and timeouts keep the current selection without automatic retries. If a model change fails, the extension attempts to restore the previous state and stops the run if restoration fails or the current model is unavailable.

The classifier receives the task, profile hints, current selection, and bounded recent conversation and tool-result text. This may send private text to the classifier service. Thinking blocks, system prompts, tool arguments, and image data are excluded.

Pi 1.2 may not expose RPC cancellation during startup; a cancelled request can still update the selection. See the [specification](docs/spec.md) for context limits and cancellation details.

## Logs

Decisions are appended as JSONL to `~/.pi/agent/extensions/pi-model-decider/logs/pi-model-decider-decisions.jsonl`. The directory is created automatically on the first decision.

```sh
tail -f ~/.pi/agent/extensions/pi-model-decider/logs/pi-model-decider-decisions.jsonl
```

Each completed selection flow records the instruction, proposed profile, validated probabilities, timings, and final result. `attempts` includes each reselect proposal and confirmation action. `classifierDurationMs` excludes confirmation waits; `durationMs` includes the whole selection flow, not the subsequent task execution. Failed or skipped classifier calls have `probabilities: null`.

Instructions are stored verbatim. Conversation history, credentials, and raw classifier responses are not logged. Logging runs while automatic selection is enabled; `/model-decider status` also shows the log path. There is no automatic rotation. A write failure warns once per session and does not interrupt model selection.

## Develop

```sh
npm ci
npm run check
npm test
```

Tests cover configuration, selection, confirmation, reselect, persistence, timeouts, and recovery, including Pi 1.2.0 SDK integration with local fake providers. No live model service is required.

## License

MIT License. Copyright © 2026 Yoshihiro Kato. See [LICENSE](LICENSE) for details.
