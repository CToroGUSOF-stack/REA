# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Primary users are software engineers, security researchers, and agents investigating local applications and binary artifacts on Windows. They need a calm workspace that helps them choose a target, understand which analysis provider is available, and keep evidence attached to an investigation.

## Product Purpose

REA turns reverse-engineering questions into inspectable analysis workflows. The Windows app should make the existing local CLI/MCP capabilities approachable without hiding evidence, uncertainty, or provider limitations.

## Positioning

REA keeps provenance and unknowns visible while bringing together static analysis, native analysis, browser observation, and application-specific workflows.

## Operating Context

Users work with local files, folders, executables, APKs, JavaScript/Electron bundles, and provider installations such as Ghidra, IDA, Hopper, Node.js, or a Chrome-family browser.

## Capabilities and Constraints

- The existing repository and CLI remain the authority for analysis semantics.
- The first Windows surface is an Electron desktop shell with native file selection and provider readiness visibility.
- Analysis actions must not imply capabilities that are unavailable or configured.
- The UI should preserve the selected target path and show clear status for pending, running, completed, and unavailable work.

## Evidence on Hand

The repository contains the REA CLI, provider adapters, contracts, documentation, and Windows native support. No existing desktop UI or product-specific visual system was found.

## Product Principles

- Make the next investigation step obvious.
- Preserve evidence provenance and uncertainty.
- Surface capability boundaries before the user commits time.
- Keep dense technical information calm and scannable.

## Accessibility & Inclusion

The app should support keyboard navigation, visible focus, sufficient contrast, reduced motion, and labels that do not rely on icon-only controls.
