// Node.js builtin packages
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { createHash } from "node:crypto";

// 3rd-party packages
// PDF generator (to merge Chromium generated PDFs into a single PDF)
import { PDFDocument } from "pdf-lib";
// logger
import { loggers } from "winston";
const logger = loggers.get("mainLogger");

// use network proxies in a round-robin manner
// (i.e. every call to getNextProxy() gets the next proxy in the list)
function getNextProxy(currentIndex, proxies) {
  let ret = undefined;
  if (proxies && proxies.length > 0 && currentIndex < proxies.length) {
    let newIndex = currentIndex + 1;
    if (newIndex >= proxies.length) {
      newIndex = 0;
    }
    ret = { proxy: proxies[currentIndex], index: newIndex };
  }
  return ret;
}

async function appendPdf(destDocument, srcPath) {
  logger.verbose(`appendPdf(): srcPath = ${srcPath}`);
  const srcBytes = await readFile(srcPath);
  const srcDoc = await PDFDocument.load(srcBytes);
  const srcIndeces = srcDoc.getPageIndices();
  const srcPages = await destDocument.copyPages(srcDoc, srcIndeces);
  srcPages.forEach((srcPage) => {
    destDocument.addPage(srcPage);
  });
}

// We've to scroll through the entire page so dynamically loaded elements are also loaded.
// Without this the Chromium generated PDF sometimes doesn't contain a couple of images.
// Especially where a video is embedded in the page and in printing (PDF) mode it's replaced by a static image.
// Implementation is based on:
// https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollHeight#problems_and_solutions
async function scrollToPageBottom(browserPage, maxScrolls) {
  const start = Date.now();
  logger.verbose("scrollToPageBottom(): start");
  const ret = await browserPage.evaluate((maxScrolls) => {
    return new Promise((resolve) => {
      const distance = 20000;
      let scrollCounter = 1;
      const scrollendHandler = function(evt) {
        const remaining = Math.abs(document.documentElement.scrollHeight - document.documentElement.clientHeight - document.documentElement.scrollTop);
        if (remaining > 1 && scrollCounter < maxScrolls) {
          scrollCounter++;
          window.scrollBy({
            top: distance,
            left: 0,
            behavior: "smooth"
          });
        } else {
          const ret = "remaining = " + remaining
            + ", scrollHeight = " + document.documentElement.scrollHeight
            + ", clientHeight = " + document.documentElement.clientHeight
            + ", scrollTop = " + document.documentElement.scrollTop
            + ", scrollCounter = " + scrollCounter
            + ", maxScrolls = " + maxScrolls
          ;
          window.removeEventListener("scrollend", scrollendHandler);
          resolve(ret);
        }
      };
      window.addEventListener("scrollend", scrollendHandler);
      window.scrollBy({
        top: distance,
        left: 0,
        behavior: "smooth"
      });
    });
  }, maxScrolls);
  // elapsed number of seconds with 3 decimal precision
  const elapsed = (Date.now() - start) / 1000;
  logger.verbose(`scrollToPageBottom(): end, finished in ${elapsed}s, result: ${ret}`);
}

function parseBrowserArgOptions(prefix, opts) {
  const parsedArgs = [];
  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i];
    const idx = opt.indexOf(",");
    if (idx >= 0) {
      parsedArgs.push(prefix + opt.substring(0, idx) + "=" + opt.substring(idx + 1));
    } else {
      parsedArgs.push(prefix + opt);
    }
  }
  return parsedArgs;
}

// TODO Get rid of the "pageLoadError" global variable. Is it possible?
let pageLoadError = false;
// helper function to set up a new browser instance (if there's none yet) and a new page (i.e. tab)
async function newBrowserPage(puppeteer, userDir, options, proxyIndex, currentPage) {
  const typeofCurrentPage = typeof currentPage;
  logger.verbose(`newBrowserPage(): userDir = ${userDir}, currentPage = ${typeofCurrentPage}`);
  const retObj = { browserPage: undefined, proxyIndex: proxyIndex }
  if (typeofCurrentPage === "undefined") {
    const browserArgs = [];
    const proxyObj = getNextProxy(proxyIndex, options.proxy);
    if (typeof proxyObj !== "undefined" && proxyObj.proxy && proxyObj.proxy.length > 0) {
      retObj.proxyIndex = proxyObj.index;
      browserArgs.push(`--proxy-server=${proxyObj.proxy}`);
    }
    browserArgs.push(...parseBrowserArgOptions("-", options.browserShortOption));
    browserArgs.push(...parseBrowserArgOptions("--", options.browserLongOption));
    const launchOpts = {
      args: browserArgs,
      defaultViewport: null,
      headless: options.headless === true,
      ignoreHTTPSErrors: options.insecure === true,
      userDataDir: userDir
    };
    logger.info("newBrowserPage(): launching new browser instance");
    logger.verbose("newBrowserPage(): launch() options:", launchOpts);
    const browser = await puppeteer.launch(launchOpts);
    retObj.browserPage = await browser.newPage();
    logger.verbose(`newBrowserPage(): browser version: ${await browser.version()}`);
  } else {
    const browser = currentPage.browser();
    try {
      logger.verbose("newBrowserPage(): closing page");
      await currentPage.close();
    } catch (error) {
      logger.error("newBrowserPage(): error while closing page:", error);
    }
    retObj.browserPage = await browser.newPage();
  }

  await retObj.browserPage.setUserAgent(options.userAgent);

  // monitor for any "significant" error responses and determine
  // whether we consider the page load successful or not
  retObj.browserPage.on("response", async (response) => {
    const responseUrl = response.url();
    const parsedResponseUrl = new URL(responseUrl);
    if ([ "http:", "https:" ].includes(parsedResponseUrl.protocol)) {
      const responseStatusCode = response.status();
      const responseFromCache = response.fromCache();
      if (response.ok()) {
        logger.debug(`page.on("response"): URL = ${responseUrl}, status: ${responseStatusCode} (fromCache: ${responseFromCache})`);
      } else {
        const hostname = parsedResponseUrl.hostname;
        if (options.resourceHttpErrorDomainSuffix.some((x) => hostname.endsWith(x)) && options.resourceHttpError.includes(responseStatusCode)) {
          logger.error(`page.on("response"): error for ${responseUrl}, status: ${responseStatusCode} (fromCache: ${responseFromCache})`);
          pageLoadError = true;
        } else {
          logger.verbose(`page.on("response"): response for ${responseUrl} was not OK, status: ${responseStatusCode} (fromCache: ${responseFromCache})`);
        }
      }
    }
  });

  return retObj;
}

// close the browser and remove the persisted data (userDir) and recreate the directory
async function cleanupBrowser(browserPage, userDir) {
  // we'll retry this page generation, but with a clean new browser profile and instance
  const browser = browserPage.browser();
  if (browser && browser.connected) {
    const debugInfo = browser.debugInfo;
    if (debugInfo) {
      const pendingProtocolErrors = debugInfo.pendingProtocolErrors;
      if (pendingProtocolErrors) {
        const errorCount = pendingProtocolErrors.length;
        logger.verbose("cleanupBrowser(): browser properties: ", { connected: browser.connected, pendingProtocolErrorsCount: errorCount });
        if (errorCount > 0) {
          logger.verbose("cleanupBrowser(): waiting for pendingProtocolErrorsCount to reduce to zero");
          await new Promise((resolve) => {
            const intervalID = setInterval(() => {
              const errLen = browser.debugInfo.pendingProtocolErrors.length;
              logger.debug(`cleanupBrowser(): browser watcher invoked, pendingProtocolErrors.length = ${errLen}`);
              if (errLen == 0) {
                logger.debug("cleanupBrowser(): browser watcher: pendingProtocolErrors is finally empty");
                clearInterval(intervalID);
                resolve();
              }
            }, 100);
          });
          logger.debug("cleanupBrowser(): browser properties: ", { connected: browser.connected, pendingProtocolErrorsCount: browser.debugInfo.pendingProtocolErrors.length });
        }
      } else {
        logger.verbose("cleanupBrowsers(): browser.debugInfo.pendingProtocolErrors is not available");
      }
    } else {
      logger.verbose("cleanupBrowser(): browser.debugInfo is not available");
    }
  } else {
    logger.verbose("cleanupBrowser(): browser is either not available or not connected");
  }
  logger.verbose("cleanupBrowser(): trying to close the page");
  try {
    await browserPage.close().then(
      (value) => {
        logger.verbose("cleanupBrowser(): page was closed");
      }, (e) => {
        logger.error("cleanupBrowser(): the page closing promise was rejected: ", e);
      }
    );
  } catch (err) {
    logger.error("cleanupBrowser(): the closing of the page threw an error: ", err);
  }
  logger.verbose("cleanupBrowser(): trying to close the browser");
  try {
    await browser.close().then((value) => {
        logger.verbose("cleanupBrowser(): the browser was closed");
      }, (e) => {
        logger.error("cleanupBrowser(): the browser closing promise was rejected: ", e);
      }
    );
  } catch (err) {
    logger.error("cleanupBrowser(): the closing of the browser threw an error: ", err);
  }
  // removing the entire browser profile directory is the only way to make 100% sure
  // that nothing persists to the next retry
  try {
    logger.verbose(`cleanupBrowser(): deleting directory at ${userDir}`);
    await rm(userDir, { recursive: true, force: true }).then(
      (value) => {
        logger.verbose(`cleanupBrowser(): directory at ${userDir} was deleted`);
      }, (e) => {
        logger.error(`cleanupBrowser(): failed to delete directory at ${userDir}`);
      }
    )
  } catch (accessErr) {
    logger.error(`cleanupBrowser(): error while deleting directory at ${userDir},`, accessErr);
  }
  try {
    logger.verbose(`cleanupBrowser(): creating directory at ${userDir}`);
    await mkdir(userDir).then(
      (value) => {
        logger.verbose(`cleanupBrowser(): directory at ${userDir} was re-created`);
      }, (e) => {
        logger.error(`cleanupBrowser(): failed to create directory at ${userDir}`);
      }
    );
  } catch (mkdirErr) {
    logger.error(`cleanupBrowser(): error while creating directory at ${userDir},`, mkdirErr);
  }
}

// generate PDFs for a set of URLs
// use intelligent caching (e.g. if a PDF already exists, we won't generate it again by default)
// apply intelligent retries in case an error occurs (e.g. a server-side throttling, etc.)
export async function generatePdfs(puppeteer, pageURLs, userDir, pdfDir, pdfDoc, options, isToCPage) {
  logger.verbose(`generatePdfs(): start, isToCPage = ${isToCPage},`, { options: options, pageURLs: pageURLs});

  let retURLs = undefined;
  let pageLoadErrorCounter = 0;
  let pageGenerationCounter = 0;
  let rejectInProgress = false;

  let { browserPage, proxyIndex } = await newBrowserPage(puppeteer, userDir, options, 0);

  try {
    for (let pageURLIdx = 0; pageURLIdx < pageURLs.length; pageURLIdx++) {
      const pageUrl = pageURLs[pageURLIdx];
      for (let pdfGenCounter = 1; ; pdfGenCounter++) {
        const urlHash = createHash("md5").update(pageUrl).digest("hex");
        const pdfFilename = "page_" + urlHash + ".pdf";
        const pdfPath = join(pdfDir, pdfFilename);
        let pdfExists = false;
        try {
          await access(pdfPath);
          pdfExists = true;
        } catch (pdfAccessError) {
          // don't care, just swallow the exception
        } finally {
          if (pdfExists && !isToCPage && options.force !== true) {
            logger.verbose(`generatePdfs(): PDF already exists for ${pageUrl} (and is not a ToC page), re-using it: ${pdfPath}`);
            await appendPdf(pdfDoc, pdfPath);
            break;
          } else {
            logger.info(`generatePdfs(): attempt #${pdfGenCounter} for ${pageUrl}`);
            const retObj = await generatePagePdf(pageUrl, pdfPath, browserPage, options, isToCPage);
            pageGenerationCounter++;
            if (retObj.pageLoadError) {
              if (options.retries == 0 || pdfGenCounter < options.retries) {
                logger.verbose(`generatePdfs(): will retry ${pageUrl}`);
              } else {
                // we've run out of retries, the PDF for this URL could not be generated successfully
                rejectInProgress = true;
                // cleaning up resources (e.g. closing browser, etc.)
                await cleanupBrowser(browserPage, userDir);
                return Promise.reject(new Error(`generatePdfs(): failed to load page at ${pageUrl} after ${options.retries} retries`));
              }
              pageLoadErrorCounter++;
              // we'll retry this page generation, but with a clean new browser profile and instance
              await cleanupBrowser(browserPage, userDir);
              if ((options.proxy && (options.proxy.length == 0 || pageLoadErrorCounter >= options.proxy.length) || !options.proxy) && options.waitTime > 0) {
                // we wait a couple of seconds if we've used up our entire proxy pool
                // for retries of this page (or if there's no proxy at all)
                pageLoadErrorCounter = 0;
                logger.info(`generatePdfs(): too many HTTP errors, waiting for ${options.waitTime}s.`);
                await new Promise(resolve => setTimeout(resolve, options.waitTime * 1000));
                logger.verbose("generatePdfs(): wait is over");
              }
              ({ browserPage, proxyIndex } = await newBrowserPage(puppeteer, userDir, options, proxyIndex));
            } else {
              // page and PDF generation were successful, so we
              // - open a new browser tab
              // - reset the error counter to zero
              // - append the generated PDF to the combined (output) PDF
              if (options.newBrowserPerUrls && options.newBrowserPerUrls > 0 && pageGenerationCounter % options.newBrowserPerUrls == 0) {
                logger.verbose(`generatePdfs(): trying to close the browser, because pageGenerationCounter is ${pageGenerationCounter} and newBrowserPerUrls is ${options.newBrowserPerUrls}`);
                await cleanupBrowser(browserPage, userDir);
                ({ browserPage, proxyIndex } = await newBrowserPage(puppeteer, userDir, options, proxyIndex));
              } else {
                ({ browserPage, proxyIndex } = await newBrowserPage(puppeteer, userDir, options, proxyIndex, browserPage));
              }
              retURLs = retObj.pageURLs;
              pageLoadErrorCounter = 0;
              logger.verbose(`generatePdfs(): PDF generation for ${pageUrl} was successful.`);
              await appendPdf(pdfDoc, pdfPath);
              break;
            }
          }
        }
      }
      logger.info(`generatePdfs(): progress: ${pageURLIdx+1} of ${pageURLs.length} URLs`);
    }
  } finally {
    // TODO
    // No idea how to do this "nicely", but if we start messing around with new Promises
    // while a Promise was already rejected, then we'll end up with an unhandledReject error.
    // The rejectInProgress flag's purpose is to avoid this scenario.
    // Imho this is a poor man's solution, there must be a better way.
    if (!rejectInProgress) {
      // cleaning up resources (e.g. closing browser, etc.)
      await cleanupBrowser(browserPage, userDir);
    }
  }

  logger.verbose("generatePdfs(): end");

  return retURLs;
}

// generate a PDF for a single URL
async function generatePagePdf(pageUrl, pdfFilePath, browserPage, options, isToCPage) {
  const retObj = { pageURLs: [], pageLoadError: false };

  try {
    logger.verbose("generatePagePdf(): goto() start");
    const start = Date.now();
    pageLoadError = false;
    
    // navigate to the given URL (on the currently open browser tab)
    // note: while goto() is in progress, we're continuously monitoring
    //       the state of `pageLoadError` and if an URL loading error is detected,
    //       we shut down the goto() operation by executing a "window.stop()"
    //       on the browser page (that is being loaded).
    //       We can win some time this way if we don't wait for all other resources
    //       to load, once we detected a significant error in any of the resources.
    let watcherResolve;
    let intervalID;
    const pageLoadErrorSignal = "pageLoadErrorOccurred";
    await Promise.race([
      browserPage.goto(pageUrl, { waitUntil: [ "load", "networkidle2" ], timeout: options.timeout }),
      new Promise((resolve) => {
        watcherResolve = resolve;
        intervalID = setInterval(() => {
          logger.debug(`generatePagePdf(): goto() progress watcher invoked, pageLoadError = ${pageLoadError}`);
          if (pageLoadError) {
            logger.debug("generatePagePdf(): goto() progress watcher: pageLoadError detected");
            clearInterval(intervalID);
            resolve(pageLoadErrorSignal);
          }
        }, 100);
      })
    ]).then(async(value) => {
      if (value === pageLoadErrorSignal) {
        logger.verbose("generatePagePdf(): a pageLoadError was detected, stopping loading of page");
        await browserPage.evaluate(() => { window.stop() });
        logger.verbose("generatePagePdf(): loading of page was stopped");
      } else {
        logger.verbose("generatePagePdf(): goto() finished first, stopping goto() progress watcher");
        clearInterval(intervalID);
        watcherResolve();
        if (value) {
          // Theoretically `value` should contain an HTTPResponse object
          // returned by the goto() call ... but just in case I'm wrong,
          // I wrap this status() call in a `try { } catch { }` block.
          try {
            const httpStatus = value.status();
            if (options.pageHttpError.includes(httpStatus)) {
              logger.error(`generatePagePdf(): goto() returned HTTP ${httpStatus} status code for ${pageUrl}, which is considered to be an error`);
              pageLoadError = true;
            } else {
              logger.verbose(`generatePagePdf(): goto() returned HTTP ${httpStatus} status code for ${pageUrl}`);
            }
          } catch (err) {
            logger.error(`generatePagePdf(): there was an unknown error while processing the return value of the goto() call`, err);
            logger.error("generatePagePdf(): the return value of the goto() call:", value);
            pageLoadError = true;
          }
        } else {
          logger.error(`generatePagePdf(): the return value of the goto() call seems to be "nullish"/empty (which should be a bug/error):`, value);
          pageLoadError = true;
        }
      }
    }).catch((e) => {
      pageLoadError = true;
      logger.error("generatePagePdf(): error while waiting for goto() to finish: ", e);
    });
    logger.verbose(`generatePagePdf(): goto() finished in ${ (Date.now() - start) / 1000 }s, pageLoadError = ${pageLoadError}`);
    
    if (options.leniency <= 7 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error during goto() for ${pageUrl}`);
    }
    pageLoadError = false;

    // we've to scroll to the end of the page so dynamically loaded elements and code
    // are triggered before the PDF generation
    // (this is necessary to make sure that there's time for everything to load properly)
    await scrollToPageBottom(browserPage, 50);

    if (options.leniency <= 6 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error while scrolling to the bottom of the page for ${pageUrl}`);
    }
    pageLoadError = false;
    
    logger.verbose("generatePagePdf(): waiting for network requests to go idle after we scrolled to the bottom");
    const start2 = Date.now();
    await browserPage.waitForNetworkIdle({ concurrency: options.idleConcurrency, timeout: options.timeout });
    logger.verbose(`generatePagePdf(): wait is finished in ${ (Date.now() - start2) / 1000 }s`);

    if (options.leniency <= 5 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error while waiting for network requests to go idle after having scrolled to the bottom for ${pageUrl}`);
    }
    pageLoadError = false;

    logger.verbose("generatePagePdf(): DOM manipulations start");
    const start3 = Date.now();

    if (isToCPage === true) {
      retObj.pageURLs = await browserPage.evaluate(() => {
        // collect all page links from the table-of-contents page
        const anchors = document.querySelectorAll("body section#ownersmanual > ul a");
        const urls = [];
        anchors.forEach((anchor) => {
          if (anchor && anchor.href && anchor.href.length > 0) {
            urls.push(anchor.href);
          }
        });
        return Promise.resolve(urls);
      });
      retObj.pageURLs = retObj.pageURLs.filter((url) => {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname;
        return options.urlDomainSuffix.some((x) => hostname.endsWith(x));
      });
      logger.verbose(`generatePagePdf(): collecting urls finished in ${ (Date.now() - start3) / 1000 }s`);
    }

    if (options.leniency <= 4 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error while collecting links from the ToC page at ${pageUrl}`);
    }
    pageLoadError = false;

    logger.verbose("generatePagePdf(): removing the page header and footer");
    // removing header and footer from the page before we save the PDF
    const failedSelectors = await browserPage.evaluate(() => {
      const result = [];
      [ "div:has(site-navigation)", "div#site-footer-embed" ].forEach((selector) => {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((element) => {
            element.remove();
          });
        } else {
          result.push(selector);
        }
      });
      return Promise.resolve(result);
    });

    failedSelectors.forEach((selector) => {
      logger.warn(`generatePagePdf(): could not find any element for the "${selector}" CSS selector (afaik this is not normal)`);
    });

    if (options.leniency <= 3 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error after having removed headers and footers from ${pageUrl}`);
    }
    pageLoadError = false;

    if (isToCPage) {
      logger.verbose("generatePagePdf(): modifying DOM of a table-of-contents page");
      const chapterExpansionStart = Date.now();
      await browserPage.evaluate((timestampStr) => {
        // add a timestamp below the page title (i.e. so the time of generation is visible)
        // (note: the PDF metadata has this info as well, but not everybody knows this and how to access it)
        const titles = document.querySelectorAll("body main h1[class^=\"heading\"]");
        if (titles.length > 0) {
          const paragraph = document.createElement("p");
          paragraph.innerText = "(" + timestampStr + " GMT)";
          titles[0].parentNode.appendChild(paragraph);
        }
        // DIVs under the <section> element contain unnecessary stuff.
        // e.g. search box and "Show other documents to download"
        // We get rid of them.
        const elements = document.querySelectorAll("body section#ownersmanual > div");
        elements.forEach((element) => {
          element.remove();
        });
        // expand all chapters and remove the button afterwards
        const buttons = document.querySelectorAll("body section#ownersmanual > ul li button");
        buttons.forEach((button) => {
          button.click();
          button.remove();
        });
      }, options.timestamp);
      logger.verbose(`generatePagePdf(): collecting urls finished in ${ (Date.now() - chapterExpansionStart) / 1000 }s`);
    }

    if (options.leniency <= 2 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error after having modified the ToC page at ${pageUrl}`);
    }
    pageLoadError = false;

    // removing the section with the "Related documents" and "More in this topic" links
    // (this is optional, some people might prefer to have these in the PDF as well)
    if (options.links !== true) {
      await browserPage.evaluate(() => {
        const elements = document.querySelectorAll("body article + div");
        elements.forEach((element) => {
          element.remove();
        });
      });
    }

    const anchorToSpanStart = Date.now();
    await browserPage.evaluate(() => {
      // replacing anchor tags with span tags
      const anchors = document.querySelectorAll("a");
      anchors.forEach((anchor) => {
        const span = document.createElement("span");
        if (anchor.className) {
          span.className = anchor.className;
        }
        if (anchor.id) {
          span.id = anchor.id;
        }
        span.style = "text-decoration-line: none; cursor: default";
        span.innerHTML = anchor.innerHTML;
        anchor.parentNode.replaceChild(span, anchor);
      });
    });
    logger.verbose(`generatePagePdf(): replacement of anchor tags finished in ${ (Date.now() - anchorToSpanStart) / 1000 }s`);

    // look for the "Reject All" button of the cookie consent overlay and click it if it's there and visible
    const rejectAllCookiesButtonHandle = await browserPage.$("body #onetrust-reject-all-handler");
    if (rejectAllCookiesButtonHandle) {
      if (await rejectAllCookiesButtonHandle.isVisible()) {
        // Volvo introduced a campaign (in Aug. 2024) to collect feedback on their support website
        // and offered money for participation.
        // This popup is displayed to all new browsers/visitors. :(
        const ethnioHandle = await browserPage.$("body #ethnio-campaign-theme");
        if (ethnioHandle) {
          if (await ethnioHandle.isVisible()) {
            await browserPage.evaluate(element => element.remove(), ethnioHandle);
            logger.verbose("generatePagePdf(): removed the #ethnio-campaign-theme element (spam popup from Volvo)");
          }
          ethnioHandle.dispose();
        }
        // This Volvo popup can take the form of a div (#ethnio-campaign-theme),
        // or an iframe. Here we remove all iframeHandles that have an "src" since normally
        // VolvoCars doesn't use any iframeHandles and this "ethnio" iframe was loaded from
        // a 3rd party URL.
        const iframeHandles = await browserPage.$$("body iframe");
        for (let i = 0; i < iframeHandles.length; i++) {
          const iframeHandle = iframeHandles[i];
          const src = await (await iframeHandle.getProperty("src")).jsonValue();
          if (src && src.length > 0) {
            await browserPage.evaluate(element => element.remove(), iframeHandle);
            logger.verbose(`generatePagePdf(): removed iframe with an src of "${src}"`);
          }
          iframeHandle.dispose();
        };
        await rejectAllCookiesButtonHandle.click();
        logger.verbose("generatePagePdf(): clicked the \"Reject All\" button on the cookie consent overlay");
        // wait for the button to disappear
        const rejectAllCookiesButtonHandle2 = await browserPage.waitForSelector("body #onetrust-reject-all-handler", { hidden: true });
        if (rejectAllCookiesButtonHandle2) rejectAllCookiesButtonHandle2.dispose();
      }
      rejectAllCookiesButtonHandle.dispose();
    }

    logger.verbose(`generatePagePdf(): DOM manipulations finished in ${ (Date.now() - start3) / 1000 }s`);

    if (options.leniency <= 1 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error after link removal from ${pageUrl}`);
    }
    pageLoadError = false;
    
    logger.verbose("generatePagePdf(): waiting for network requests to go idle after DOM manipulations");
    const start4 = Date.now();
    await browserPage.waitForNetworkIdle({ concurrency: options.idleConcurrency, timeout: options.timeout });
    logger.verbose(`generatePagePdf(): wait is finished in ${ (Date.now() - start4) / 1000 }s`);

    if (options.leniency == 0 && pageLoadError) {
      throw new Error(`generatePagePdf(): there was an error while waiting for network requests to go idle after DOM manipulations for ${pageUrl}`);
    }

    // save PDF of the page
    logger.verbose("generatePagePdf(): generating PDF");
    if (typeof pdfFilePath !== "undefined") {
      const start = Date.now();
      await browserPage.pdf({
        displayHeaderFooter: options.displayHeaderFooter === true,
        path: pdfFilePath,
        format: options.pdfPageSize,
        margin: {
          top: options.pdfTopBottomMargin,
          bottom: options.pdfTopBottomMargin,
          left: options.pdfLeftRightMargin,
          right: options.pdfLeftRightMargin
        },
        omitBackground: options.pdfOmitBackground === true,
        printBackground: options.pdfPrintBackground,
        timeout: options.pdfTimeout
      });
      logger.verbose(`generatePagePdf(): PDF saved in ${ (Date.now() - start) / 1000 }s`);
    }
  
    // at this stage we consider the page-to-PDF process a success
    // note: we shouldn't have a pageLoadError === true situation here, so just logging it to make sure we actually don't :)
    logger.verbose(`generatePagePdf(): pdf generation was a success (pageLoadError: ${pageLoadError})`);
  } catch (pageError) {
    logger.error(`generatePagePdf(): error for ${pageUrl}: ${pageError.message}`);
    retObj.pageLoadError = true;
  }

  logger.verbose("generatePagePdf(): end");
  return retObj;
}
