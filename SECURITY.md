# Security Policy

## Supported versions

Security fixes are applied to the latest revision of the `main` branch. The project has not published a stable release series yet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue for a suspected vulnerability or include private document content, images, credentials, or exploit details in public discussions.

Include the affected version or commit, reproduction steps, expected impact, and any suggested mitigation. You should receive an acknowledgement within seven days. A fix and disclosure timeline will be coordinated based on severity and complexity.

## Security boundaries

Naranhi sends translation requests only to the local Ollama endpoint at `127.0.0.1:11434`. OCR is performed locally with Apple Vision on macOS. Contributors should treat any change that introduces network destinations, telemetry, automatic updates, or external model providers as security-sensitive and document it clearly.
