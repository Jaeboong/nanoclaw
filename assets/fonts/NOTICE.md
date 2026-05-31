# Fonts bundled with NanoClaw

All fonts in this directory are licensed under the SIL Open Font License 1.1.
The full license text is distributed in `OFL.txt` (also available at
https://scripts.sil.org/OFL).

## Files

| File | Source | Purpose |
|---|---|---|
| `NotoSansMono-Regular.ttf` | [googlefonts/noto-fonts](https://github.com/googlefonts/noto-fonts) | Latin monospace (cell body) |
| `NotoSansMono-Bold.ttf`    | [googlefonts/noto-fonts](https://github.com/googlefonts/noto-fonts) | Latin monospace (header row) |
| `NotoSansKR-Regular.otf`   | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk) (SubsetOTF/KR) | Hangul fallback (cell body) |
| `NotoSansKR-Bold.otf`      | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk) (SubsetOTF/KR) | Hangul fallback (header row) |
| `NotoEmoji-Regular.ttf`    | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notoemoji) | Monochrome emoji fallback (⭐⚠️🔍 etc.) |

Loaded at startup by `src/channels/discord-table-render.ts` when
`@napi-rs/canvas` is available. Used to render markdown tables as PNG
attachments on Discord.
