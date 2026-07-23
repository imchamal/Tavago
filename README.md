# Tavago

Tavago is a minimal SillyTavern translation extension test.

## Current test feature

- Adds a Tavago settings panel.
- Uses a Font Awesome icon instead of a PNG icon file.
- Uses the current SillyTavern API connection through `generateRaw()`.
- Adds an input translation icon next to the SillyTavern send button.
- Short press on the input icon translates or toggles original/translation.
- Long press on the input icon retranslates the input text.
- Supports Korean/English bidirectional input translation.
- Uses a single target language for message reading.
- Adds a Tavago translate button to chat messages.
- Short press on a message button toggles original/translation.
- Long press on a message button retranslates the message.
- Auto-translates new messages by selected target: off, both, user only, or AI only.
- Prevents duplicate translation requests on the same message while a translation is already running.
- Stores the target language, prompt, and timestamp used for each saved message translation.
- Marks saved message translations as outdated when they no longer match the current message translation settings.
- Stores translation failure details and marks failed message buttons with an error color.
- Supports optional dual-line display for selected dialogue-like segments as `original [translation]`.

## Install for testing

Place this folder here:

```text
SillyTavern/public/scripts/extensions/third-party/Tavago
```

Then restart SillyTavern or reload the browser page.

## Notes

Saved chat message translations keep the original message text and only change the display text.
