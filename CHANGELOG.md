# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.1] - 2020-01-08
### Changed
- Replaced Math.random() with deterministic alternative pulled from v8
- Fixed accidental logfile creation named `undefined`.
### Added
- TermAggregator: Transfers totals were added to peer display

## [0.9.0] - 2020-01-15
### Added
- Elasticsearch indexing support

## [0.10.0] - 2020-01-xx
### Added
- Deterministic pseudo `random()` is now available via peer context
- `context.timeout(Number) -> Promise` added. setTimeout() for Simulated time.
### Changed
- Fixed eternal loop bug caused by fifo.peek()
