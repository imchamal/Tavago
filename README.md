# Pavago

Pavago is a SillyTavern translation extension that uses the currently selected SillyTavern API connection.

## Features

- Translates user messages, AI messages, and unsent input text.
- Adds a translate/toggle button next to chat messages.
- Adds an input translation button next to the send button.
- Short press toggles between original and translation.
- Long press retranslates from the original text.
- Supports Korean/English bidirectional input translation.
- Supports automatic translation for both messages, user messages only, or AI messages only.
- Lets you choose a SillyTavern API connection profile for translation.
- Saves translated chat messages without replacing the original message text.
- Marks saved translations as outdated when translation settings change.
- Stores translation failure details and shows failed messages with an error state.
- Supports optional `original [translation]` display for double-quoted and backticked text.
- Supports translation style, temperature, max tokens, and previous-message context settings.
- Includes a current-chat translation cache reset button.

## Installation

Place this folder here:

```text
SillyTavern/public/scripts/extensions/third-party/Pavago
```

Then restart SillyTavern or reload the browser page.

## Notes

Pavago keeps the original chat message in `message.mes` and stores translated output separately in message metadata.

If you used an older Tavago test build, Pavago will try to migrate saved Tavago settings and message translation data automatically.
