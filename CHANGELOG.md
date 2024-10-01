# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.11] - 2024-10-01

### Added

- Print Alpine and NodeJS versions to stdout if `--log-level debug` option is used.

### Changed

- Upgraded docker image dependency (`node:22.8.0-alpine3.20` -> `node:22.9.0-alpine3.20`).
- Upgraded npm dependencies (puppeteer: 23.2.2 -> 23.4.1).

### Fixed

- There was an unnecessary space at the start of one of the cmdline option descriptions.
- The removal of Volvo's nagging "Do you have a second?" popup was mistakenly depending on the existence of the cookie consent popup.

## [1.0.10] - 2024-09-04

### Changed

- The `--timestamp` commandline option was replaced with `--title-caption`. This allows the text below the document title (on the ToC page) to be anything, not just a string with " GMT" attached.
- The default value of both `--title-caption` and `--output` is now printed in the help output.
- The application now exits with an error code (and not just logs errors) if an error occurred.

## [1.0.9] - 2024-09-04

### Added

- Added the `nss` Alpine package to the docker image, because it's a dependency of Chromium and most online sources suggest to have it in there. The `chromium` package already has a `so:libnss3.so` dependency, which I think installs `nss`, but it won't hurt to have this package dependency explicitly in our build.
- Added two new font packages to the docker image build (`font-freefont`, `font-opensans`).
- The docker image now contains the `Dockerfile` and the `CHANGELOG.md` too.

### Changed

- The base docker image got more specific: added NodeJS's minor and patch version too to improve the reproducibility of docker image builds.
- Upgraded NodeJS dependencies to their latest versions (puppeteer: 23.2.2, winston: 3.14.2).

### Fixed

- Alpine's Chromium was (recently?) updated from 126.\* to 128.\* (this change creeped into the 1.0.8 release) and this broke the way this project used Chromium on Arm64 (aarch64) CPUs. To fix this, Alpine's Chromium SwiftShader package (`chromium-swiftshader`) was added. An alternative could have been to use `--disable-gpu` cmdline switch, but from online sources it seemed to me that this switch is on its way of getting deprecated.

## [1.0.8] - 2024-09-02

### Added

- the browser's version string is logged on verbose level

### Changed

- a couple of commandline option arguments accepted a comma-separated argument list, these have no been modified so that the option itself can be used multiple times and the arguments are collected into a list (these options are: `--url-domain-suffix`, `--page-http-errors`, `--resource-http-errors`, `--resource-http-error-domain-suffixes`)
- all calls to document.querySelector() have been changed into document.querySelectorAll(), because it is more robust

### Fixed

- `--browser-long-option` and `--browser-short-option` option arguments were not parsed correctly and default value was not shown in the format that is expected for the option's argument
- Volvo added a new nagging popup which must be handled as well (besides the cookie consent popup).

## [1.0.7] - 2024-07-23

### Added

- HTTP status error codes (i.e. the status codes that we handle as errors and retry the given page) can now be separately specified for the page URL and its resource URLs (i.e. the URLs that are loaded while the page is being rendered). Previously the default set of HTTP status error codes didn't contain 404, because it's usually not a transient error and a retry shouldn't fix it. But in case of page URLs (especially on volvocars.com) this can be a sign of a transient error and now we retry that page instead of simply saving as PDF.

### Changed

- improved a bit on logging (added HTTP status codes where they were not logged before)

## [1.0.6] - 2024-07-12

### Changed

- we are now removing the chapter opening/closing buttons from the table-of-contents page after the chapters were opened and before the PDF is generated

## [1.0.5] - 2024-07-12

### Fixed

- the filename/path on the "--output" option was not honored as it was (the date&time was injected into it as well), now the application takes this path literally

## [1.0.4] - 2024-07-12

### Fixed

- added a shell script wrapper (entrypoint.sh) around pdfgen4vcman-cli.js to create a HOME directory and set the env on startup so the image can truely be run with any UID (as intended)
- improved error handling so no PDF is saved in the /work directory if an error occured during PDF generation
- PDF is not saved if no pages have been added
- fixed a log message (it contained a mistaken function name)

## [1.0.3] - 2024-07-11

### Added

- added a couple of fields to package.json (homepage, repository, bugs)

### Changed

- updated a couple of dependencies in package-lock.json

## [1.0.2] - 2024-07-11

### Added

- empty pages are now automatically detected and removed from the combined PDF using Ghostscript's ink coverage output device
- Docker: added Ghostscript for empty page detection and a number of fonts and related packages for better font and Unicode characterset coverage (e.g. Japanese characters were not rendered)
- added documentation of the new empty page detection and removal feature
- added new options to control Puppeteer PDF generation parameters
- added `--font-render-hinting=none` and `--force-color-profile=generic-rgb` as default Chrome cmdline options

### Changed

- PDF generation's `printBackground` default value is now `true`
- PDF generation's `omitBackground` default value is now `false`

## [1.0.1] - 2024-07-07

### Added

- this changelog
- Docker: LICENSE file is now included as well
- README.md: added info about logging
- if an HTTP error occurs that would result in a page load failure anyway, now we don't wait for the page.goto() navigation to finish (on its own), but shut it down explicitly and immediately (saving time in the process)

### Fixed

- Docker: "/home/appuser/.npm" is now cleared at the right step (minimal reduction in image size)
- a number of async issues (race conditions) have been resolved
- more robust error handling in a lot places (i.e. catch() statements)
- closing the browser sometimes threw an error

### Changed

- default value of the `--retries` parameter has been changed from zero to `5` so we won't do retries forever (`pdfgen4vcman` is now robust enough so that if `5` retries don't work, more won't help either)
- the `uncaughtExceptionMonitor` event handler was replaced with an `uncaughtException` handler
- `winston` (the logger) now doesn't handle uncaught exceptions and unhandled rejects, only our own code does (and does the cleanup as well before we exit)

## [1.0.0] - 2024-07-06

### Added

- Initial release (feature complete and mostly stable)

[1.0.1]: https://github.com/muzso/pdfgen4vcman/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/muzso/pdfgen4vcman/releases/tag/1.0.0
