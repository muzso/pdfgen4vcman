# pdfgen4vcman

This is an unofficial PDF generator for online user manuals at volvocars.com.

It:

- collects all user manual page URLs from the table-of-contents page
- applies a couple of optimizations for each page to make PDF generation more practical (e.g. removal of page header and footer)
- generates a PDF for all pages of the user manual
- merges together all these PDFs into a single PDF (by default named `manual_<current_date_and_time>.pdf`)

## Disclaimer

All development and testing was done solely on Linux (Ubuntu) so on any other platform YMMV.

If you encounter a bug, open a GH issue. If you have an idea for a fix, pull requests are welcome.

This application is strictly a hobby project (I maintain it in my free time), thus I don't make any promises on deadlines for bugfixes, new features, review of GH issues and PRs.

Moreover I don't take any responsibility if it malfunctions in any way. Obviously the goal is that it acts as advertised, but you may never know what can lead to your computer catching fire. You have been warned. ;)

## Quick start

1. Go to [https://www.volvocars.com/uk/support/car](https://www.volvocars.com/uk/support/car). If you want the manual in a language other than English, you can substitute the country code ("uk") with any other country code that volvocars.com supports.
2. Select a car model and a model year.
3. Scroll down to the "More car information" section and click the "... manual" button.
4. If you see a table-of-contents of the online manual (and not just links to PDF manuals), then you can generate a PDF from the online manual by feeding the URL of the table-of-contents page into `pdfgen4vcman`.

### Running via Docker

```bash
docker run --rm -u "$(id -u):$(id -g)" -v "$(pwd):/work" muzso/pdfgen4vcman [options...] "<volvocars_user_manual_url>"
```

### Running the npmjs package

Either:

```bash
npm -g install pdfgen4vcman
pdfgen4vcman [options...] "<volvocars_user_manual_url>"
```

Or:

```bash
npx pdfgen4vcman [options...] "<volvocars_user_manual_url>"
```

### Running from source

1. Clone or download this [GitHub repository](https://github.com/muzso/pdfgen4vcman) and enter the new directory.
2. Install dependencies: `npm install`
3. Configure symlinks for scripts: `npm link`
4. Run `pdfgen4vcman`.

```bash
pdfgen4vcman [options...] "<volvocars_user_manual_url>"
```

## Advanced usage

Use the `--help` option to print a description of the supported commandline options.

## Volvocars.com vs. scraping

Volvocars.com uses a CDN (Content Delivery Network) service for hosting static files, e.g. images, JavaScript, CSS, etc. This CDN applies a couple of anti-scraping techniques, e.g. it detects the use of a headless browser and/or the use of the Puppeteer tool.

For the most part this can be worked around by using the [puppeteer-extra-plugin-stealth](https://www.npmjs.com/package/puppeteer-extra-plugin-stealth) `puppeteer-extra` plugin, which this application already does.

However volvocars.com still starts to hit Puppeteer clients with HTTP 403 responses after a little more than a 100 page downloads. To work around this, `pdfgen4vcman` automatically restarts the headless browser after 100 page loads, which seems to fix the issue.

Moreover `pdfgen4vcman` detects when volvocars.com starts to reply with HTTP 403 responses and if this happens, the browser is restarted as well.

## Tips and tricks

If the default behaviour of `pdfgen4vcman` is still not enough (e.g. volvocars.com starts to throttle the requests beyond a certain req/s rate), you can start up a couple of Tor proxies and use them for the PDF generation:

```bash
p=10050
for c in de nl at lu fr; do
  /usr/bin/docker run --rm --name "torproxy_$p" -p "127.0.0.1:$p:8118" -e TOR_MaxCircuitDirtiness=300 -e "LOCATION=$c" -d dperson/torproxy
  p="$((p+1))"
done

pdfgen4vcman \
  --proxy "http://127.0.0.1:10050" \
  --proxy "http://127.0.0.1:10051" \
  --proxy "http://127.0.0.1:10052" \
  --proxy "http://127.0.0.1:10053" \
  --proxy "http://127.0.0.1:10054" \
  "<volvocars_user_manual_url>"
```

There're a couple of old user manuals at volvocars.com which try to embed images for which a consistent HTTP 403 is returned.

E.g.

- car model: XC90 Twin Engine
- model year: 2016

This doesn't seem to be a part of the anti-scraping techniques, but more likely a misconfiguration.

In this case you'll have to disable the automatic anti-scraping detection (automatic retries on HTTP 403 responses) by supplying a custom set of HTTP error codes for the automatic retry feature.

```bash
pdfgen4vcman --http-errors "$(seq -s "," 400 499 | sed -r "s#(,40[1347]),#,#g"),$(seq -s "," 500 599)" "https://www.volvocars.com/uk/support/car/xc90-twin-engine/15w46/article"
```

This will ignore HTTP 403 errors from volvocars.com, but still consider a bunch of 4xx status codes and all 5xx status codes to be errors (in which case the page loading should be retried).

## Removing empty pages

For some reason a couple URLs in the user manuals result in an empty last page in the generated PDF. This is probably due to something invisible extending the "content" part of the page. In other cases there's a single horizontal line on the top of the last page of the PDF, but I consider these to be "empty" as well.

You can remove these empty pages from the final PDF with the following command. It works for my use-case, but you might have to fine-tune the value of `sensitivity`.

You'll need both the `pdftk` and the `gs` (i.e. Ghostscript) utilities.

```bash
filename="manual.pdf"

pdftk "$filename" cat $(gs -q -o - -sDEVICE=inkcov "$filename" | awk -v sensitivity=0.008 '$1 + $2 + $3 + $4 >= sensitivity { printf("%d ", NR) }') output manual_wo_empty_pages.pdf
```
