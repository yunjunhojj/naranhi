# Contributing to Naranhi

Thank you for helping improve Naranhi. Bug reports, design discussions, documentation fixes, translations, and code contributions are welcome.

## Before you start

- Search existing issues before opening a new one.
- Open an issue before starting a large behavior or architecture change.
- Keep pull requests focused on one concern.
- Never include book text, screenshots, credentials, or other content you do not have permission to publish.

## Local development

You need Node.js 20 or later, the Rust stable toolchain, the Tauri prerequisites for macOS, and Ollama.

```bash
npm ci
ollama pull translategemma:12b-it-q4_K_M
npm run tauri dev
```

Image OCR currently uses Apple Vision and therefore requires macOS. Text translation and the React interface are designed so additional operating-system OCR backends can be added later.

## Checks

Run these commands before submitting a pull request:

```bash
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
```

If you change behavior, describe how you tested it. For visual changes, include before-and-after screenshots when practical.

## Commits and pull requests

- Write commit subjects in English and use the imperative mood.
- Explain the motivation and user-visible result in the pull request.
- Link related issues with `Closes #123` when applicable.
- Confirm that no private text or image data is included in tests or fixtures.

By contributing, you agree that your contribution is licensed under the MIT License.
