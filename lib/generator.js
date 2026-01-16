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

// TODO Get rid of the "resourceLoadErrorCounter" global variable.
// Is it possible to do it while keeping the code "lean"?
// (I.e. not passing this as an object through zillion function calls)
let resourceLoadErrorCounter = 0;

// helper function to set up a new browser instance (if there's none yet) and a new page (i.e. tab)
async function newBrowserPage(puppeteer, userDir, options, startNew, proxyIndex, isLastURL, currentPage) {
  logger.verbose(`newBrowserPage(): userDir = ${userDir}`);
  if (options.keepBrowser && isLastURL) {
    logger.verbose("newBrowserPage(): keepBrowser option was specified and this is/was the last URL to be processed, so skipping");
    return { browserPage: currentPage, proxyIndex: proxyIndex};
  }
  const retObj = { browserPage: undefined, proxyIndex: proxyIndex }
  if (startNew) {
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
      acceptInsecureCerts: options.insecure === true,
      userDataDir: userDir
    };
    logger.info("newBrowserPage(): launching new browser instance");
    logger.verbose("newBrowserPage(): launch() options:", launchOpts);
    const browser = await puppeteer.launch(launchOpts);
    const version = await browser.version();
    logger.verbose(`newBrowserPage(): browser version: ${version}`);
    if (!options.userAgent || options.userAgent.length == 0) {
      const anonVersion = version.replace(new RegExp("(/[0-9]+)(\\.[0-9]+)+"), "$1.0.0.0");
      options.userAgent = options.defaultUserAgent.replace("{VERSION}", anonVersion);
    }
    retObj.browserPage = await browser.newPage();
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

  logger.verbose(`newBrowserPage(): setting userAgent to: ${options.userAgent}`);
  await retObj.browserPage.setUserAgent(options.userAgent);

  // monitor for any "significant" error responses and determine
  // whether we consider the page load successful or not
  retObj.browserPage.on("response", async (response) => {
    const responseUrl = response.url();
    const timing = response.timing();
    let responseTime = 0;
    if (timing !== null) {
      responseTime = Math.round(timing.receiveHeadersStart - timing.sendEnd);
    }
    const parsedResponseUrl = new URL(responseUrl);
    if ([ "http:", "https:" ].includes(parsedResponseUrl.protocol)) {
      const responseStatusCode = response.status();
      const responseFromCache = response.fromCache();
      if (!options.resourceHttpError.includes(responseStatusCode)) {
        logger.debug(`page.on("response"): URL = ${responseUrl}, status: ${responseStatusCode} (fromCache: ${responseFromCache}, responseTime: ${responseTime} ms)`);
      } else {
        const hostname = parsedResponseUrl.hostname;
        if (options.resourceHttpErrorDomainSuffix.some((x) => hostname.endsWith(x))) {
          if (options.resourceHttpErrorUrlException.some((x) => x.test(responseUrl))) {
            logger.verbose(`page.on("response"): response for ${responseUrl} was not OK, but URL is on the regexp exception list, status: ${responseStatusCode} (fromCache: ${responseFromCache}, responseTime: ${responseTime} ms)`);
          } else {
            logger.error(`page.on("response"): error for ${responseUrl}, status: ${responseStatusCode} (fromCache: ${responseFromCache}, responseTime: ${responseTime} ms)`);
            resourceLoadErrorCounter++;
          }
        } else {
          logger.verbose(`page.on("response"): response for ${responseUrl} was not OK, but domain suffix is not on the watch-for-errors list, status: ${responseStatusCode} (fromCache: ${responseFromCache}, responseTime: ${responseTime} ms)`);
        }
      }
    }
  });

  return retObj;
}

// close the browser and remove the persisted data (userDir) and recreate the directory
async function cleanupBrowser(browserPage, userDir, options, isLastURL) {
  if (options.keepBrowser && isLastURL) {
    logger.verbose("cleanupBrowser(): keepBrowser option was specified and this is/was the last URL to be processed, so skipping browser cleanup");
    return;
  }

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

  let { browserPage, proxyIndex } = await newBrowserPage(puppeteer, userDir, options, true, 0, false);

  try {
    const lastURLIdx = pageURLs.length > 0 ? pageURLs.length - 1 : 0;
    for (let pageURLIdx = 0; pageURLIdx < pageURLs.length; pageURLIdx++) {
      const isLastURL = pageURLIdx == lastURLIdx;
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
                await cleanupBrowser(browserPage, userDir, options, isLastURL);
                return Promise.reject(new Error(`generatePdfs(): failed to load page at ${pageUrl} after ${options.retries} retries`));
              }
              pageLoadErrorCounter++;
              // we'll retry this page generation, but with a clean new browser profile and instance
              await cleanupBrowser(browserPage, userDir, options, isLastURL);
              if ((options.proxy && (options.proxy.length == 0 || pageLoadErrorCounter >= options.proxy.length) || !options.proxy) && options.waitTime > 0) {
                // we wait a couple of seconds if we've used up our entire proxy pool
                // for retries of this page (or if there's no proxy at all)
                pageLoadErrorCounter = 0;
                logger.info(`generatePdfs(): too many HTTP errors, waiting for ${options.waitTime}s.`);
                await new Promise(resolve => setTimeout(resolve, options.waitTime * 1000));
                logger.verbose("generatePdfs(): wait is over");
              }
              ({ browserPage, proxyIndex } = await newBrowserPage(puppeteer, userDir, options, true, proxyIndex, isLastURL));
            } else {
              // page and PDF generation were successful, so we
              // - open a new browser tab
              // - reset the error counter to zero
              // - append the generated PDF to the combined (output) PDF
              const newBrowserIsNeeded = options.newBrowserPerUrls && options.newBrowserPerUrls > 0 && pageGenerationCounter % options.newBrowserPerUrls == 0;
              if (newBrowserIsNeeded) {
                logger.verbose(`generatePdfs(): trying to close the browser, because pageGenerationCounter is ${pageGenerationCounter} and newBrowserPerUrls is ${options.newBrowserPerUrls}`);
                await cleanupBrowser(browserPage, userDir, options, isLastURL);
              }
              ({ browserPage, proxyIndex } = await newBrowserPage(puppeteer, userDir, options, newBrowserIsNeeded, proxyIndex, isLastURL, browserPage));
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
      await cleanupBrowser(browserPage, userDir, options, true);
    }
  }

  logger.verbose("generatePdfs(): end");

  return retURLs;
}

async function catchResourceLoadErrors(options, functionParam) {
  const errorsBefore = resourceLoadErrorCounter;
  let ret = false;
  try {
    await functionParam();
    const errorsAfter = resourceLoadErrorCounter;
    ret = errorsAfter - errorsBefore >= 0 && errorsAfter > options.resourceHttpErrorAllowed;
    logger.debug(`catchResourceLoadErrors(): resourceLoadErrors=${errorsAfter - errorsBefore}, ret=${ret}`);
  } catch(err) {
    const errorsAfter = resourceLoadErrorCounter;
    ret = errorsAfter - errorsBefore >= 0 && errorsAfter > options.resourceHttpErrorAllowed;
    logger.debug(`catchResourceLoadErrors(): resourceLoadErrors=${errorsAfter - errorsBefore}, ret=${ret}`);
    logger.error("catchResourceLoadErrors(): error while executing function, ", err);
    throw err;
  }
  return ret;
}

// generate a PDF for a single URL
async function generatePagePdf(pageUrl, pdfFilePath, browserPage, options, isToCPage) {
  const retObj = { pageURLs: [], pageLoadError: false };

  try {
    logger.verbose("generatePagePdf(): goto() start");
    const start = Date.now();
    resourceLoadErrorCounter = 0;
    
    // navigate to the given URL (on the currently open browser tab)
    // note: while goto() is in progress, we're continuously monitoring
    //       the state of `resourceLoadErrorCounter` and if a URL loading error is detected,
    //       we shut down the goto() operation by executing a "window.stop()"
    //       on the browser page (that is being loaded).
    //       We can win some time this way if we don't wait for all other resources
    //       to load, once we detected a significant error in any of the resources.
    let watcherResolve;
    let intervalID;
    let pageGotoError = false;
    const pageLoadErrorSignal = "pageLoadErrorOccurred";
    await Promise.race([
      browserPage.goto(pageUrl, { waitUntil: [ "load", "networkidle2" ], timeout: options.timeout }),
      new Promise((resolve) => {
        watcherResolve = resolve;
        intervalID = setInterval(() => {
          logger.debug(`generatePagePdf(): goto() progress watcher invoked, resourceLoadErrorCounter = ${resourceLoadErrorCounter}`);
          if (resourceLoadErrorCounter > options.resourceHttpErrorAllowed) {
            pageGotoError = true;
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
          // Theoretically `value` should contain an HTTPResponse object for
          // the page load request returned by the goto() call ... but just
          // in case I'm wrong, I wrap this status() call in
          // a `try { } catch { }` block.
          try {
            const httpStatus = value.status();
            if (options.pageHttpError.includes(httpStatus)) {
              logger.error(`generatePagePdf(): goto() returned HTTP ${httpStatus} status code for ${pageUrl}, which is considered to be an error`);
              pageGotoError = true;
            } else {
              logger.verbose(`generatePagePdf(): goto() returned HTTP ${httpStatus} status code for ${pageUrl}`);
            }
          } catch (err) {
            logger.error("generatePagePdf(): there was an unknown error while processing the return value of the goto() call", err);
            logger.error("generatePagePdf(): the return value of the goto() call:", value);
            pageGotoError = true;
          }
        } else {
          logger.error("generatePagePdf(): the return value of the goto() call seems to be \"nullish\"/empty (which should be a bug/error):", value);
          pageGotoError = true;
        }
      }
    }).catch((e) => {
      pageGotoError = true;
      logger.error("generatePagePdf(): error while waiting for goto() to finish: ", e);
    });
    logger.verbose(`generatePagePdf(): goto() finished in ${ (Date.now() - start) / 1000 }s, pageGotoError = ${pageGotoError}`);
    
    if (options.leniency <= 11 && pageGotoError) {
      throw new Error(`generatePagePdf(): there was an error during goto() for ${pageUrl}`);
    }

    if (options.hyphenation !== true) {
      // Inject custom CSS to disable hyphenation.
      // Later on this will make it easier to convert the PDF to text
      // by keeping the layout (upon repeated PDF generations) and
      // create a diff of changes consistently (without variations
      // due to automatic hyphenation).
      logger.debug("generatePagePdf(): adding CSS to page to disable hyphenation");
      await browserPage.addStyleTag({
        content: `
            * {
                hyphens: none !important;
                -webkit-hyphens: none !important;
                -ms-hyphens: none !important;
            }
        `
      });
    }

    // we've to scroll to the end of the page so dynamically loaded elements and code
    // are triggered before the PDF generation
    // (this is necessary to make sure that there's time for everything to load properly)
    const scrollToPageBottomError = await catchResourceLoadErrors(options, async () => {
      await scrollToPageBottom(browserPage, 50);
    });

    if (options.leniency <= 10 && scrollToPageBottomError) {
      throw new Error(`generatePagePdf(): there was an error while scrolling to the bottom of the page for ${pageUrl}`);
    }
    
    logger.verbose("generatePagePdf(): waiting for network requests to go idle after we scrolled to the bottom");
    const start2 = Date.now();
    const waitForIdleAfterScrollError = await catchResourceLoadErrors(options, async () => {
      await browserPage.waitForNetworkIdle({ concurrency: options.idleConcurrency, timeout: options.timeout });
    });
    logger.verbose(`generatePagePdf(): wait is finished in ${ (Date.now() - start2) / 1000 }s`);

    if (options.leniency <= 9 && waitForIdleAfterScrollError) {
      throw new Error(`generatePagePdf(): there was an error while waiting for network requests to go idle after having scrolled to the bottom for ${pageUrl}`);
    }

    logger.verbose("generatePagePdf(): DOM manipulations start");

    if (isToCPage === true) {
      logger.verbose("generatePagePdf(): collecting page URLs from the table-of-contents page");
      const tocLinkCollectionError = await catchResourceLoadErrors(options, async () => {
        const start3 = Date.now();
        retObj.pageURLs = await browserPage.evaluate(() => {
          // collect all page links from the table-of-contents page
          const urls = [];
          document.querySelectorAll("body section#ownersmanual > ul a").forEach((anchor) => {
            if (anchor && anchor.href && anchor.href.length > 0) {
              urls.push(anchor.href);
            }
          });
          return Promise.resolve(urls);
        });
        logger.verbose(`generatePagePdf(): collected ${retObj.pageURLs.length} urls from the table-of-contents page`);
        retObj.pageURLs = retObj.pageURLs.filter((url) => {
          const parsedUrl = new URL(url);
          const hostname = parsedUrl.hostname;
          return options.urlDomainSuffix.some((x) => hostname.endsWith(x));
        });
        logger.verbose(`generatePagePdf(): ${retObj.pageURLs.length} urls remained from the table-of-contents page after filtering`);
        logger.verbose(`generatePagePdf(): collecting urls finished in ${ (Date.now() - start3) / 1000 }s`);
      });

      if (options.leniency <= 8 && tocLinkCollectionError) {
        throw new Error(`generatePagePdf(): there was an error while collecting links from the table-of-contents page at ${pageUrl}`);
      }

      logger.verbose("generatePagePdf(): modifying DOM of a table-of-contents page");
      const chapterExpansionStart = Date.now();
      const tocModificationError = await catchResourceLoadErrors(options, async() => {
        await browserPage.evaluate((titleCaptionStr) => {
          if (titleCaptionStr && titleCaptionStr.length > 0) {
            // add a text below the page title
            const titles = document.querySelectorAll("body h1[class^=\"heading\"]");
            if (titles.length > 0) {
              const paragraph = document.createElement("p");
              paragraph.innerText = "(" + titleCaptionStr + ")";
              titles[0].parentNode.appendChild(paragraph);
            }
          }
          // DIVs under the <section> element contain unnecessary stuff.
          // e.g. search box and "Show other documents to download"
          // We get rid of them.
          document.querySelectorAll("body section#ownersmanual > div").forEach((element) => {
            element.remove();
          });
          // expand all chapters and remove the button afterwards
          document.querySelectorAll("body section#ownersmanual > ul li button").forEach((button) => {
            button.click();
            button.remove();
          });
          // apply a more compact look to the ToC
          document.querySelectorAll("body section#ownersmanual > ul > li > div").forEach((element) => {
              element.style.padding = "0.25rem 0";
          });
          document.querySelectorAll("body section#ownersmanual > ul > li > ul").forEach((element) => {
            element.style.padding = "0.2rem 0 1rem 0";
          });
          [
            "body section#ownersmanual > ul ul li",
            "body section#ownersmanual > ul ul li div",
            "body section#ownersmanual > ul ul li a"
          ].forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => {
              element.style.padding = "0.2rem 0";
            })
          });
        }, options.titleCaption);
      });
      logger.verbose(`generatePagePdf(): table-of-contents page modification finished in ${ (Date.now() - chapterExpansionStart) / 1000 }s`);

      if (options.leniency <= 6 && tocModificationError) {
        throw new Error(`generatePagePdf(): there was an error after having modified the ToC page at ${pageUrl}`);
      }
    }

    // removing a couple of probably unwanted sections
    // e.g. "Related articles", "More in this topic"
    // (this is optional, some people might prefer to have these in the PDF as well)
    if (!isToCPage && options.links !== true) {
      const relatedRemovalError = await catchResourceLoadErrors(options, async() => {
        const sectionRemovalLogs = await browserPage.evaluate(() => {
          const logs = [];
          [
            "body div[class^=\"ArticlePageLayout\"][class*=\"relatedArticles\"]",
            "body div:has(> div[class^=\"TitleCardList\"][class*=\"container\"])"
          ].forEach((selector) => {
            const elements = document.querySelectorAll(selector);
            logs.push(`found and removed ${elements.length} elements for the "${selector}" selector`);
            elements.forEach((element) => {
              element.remove();
            });
          });
          return Promise.resolve(logs);
        });
        sectionRemovalLogs.forEach((log) => {
          logger.verbose(`generatePagePdf(): ${log}`);
        });
      });

      if (options.leniency <= 5 && relatedRemovalError) {
        throw new Error(`generatePagePdf(): there was an error after Related and More in topics removal from ${pageUrl}`);
      }
    }

    const anchorToSpanStart = Date.now();
    const hyperlinkConversionError = await catchResourceLoadErrors(options, async() => {
      await browserPage.evaluate(() => {
        // replacing anchor tags with span tags since we don't need hyperlinks in a PDF
        document.querySelectorAll("a").forEach((anchor) => {
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
    });
    logger.verbose(`generatePagePdf(): replacement of anchor tags finished in ${ (Date.now() - anchorToSpanStart) / 1000 }s`);

    if (options.leniency <= 4 && hyperlinkConversionError) {
      throw new Error(`generatePagePdf(): there was an error after hyperlink->span conversion in ${pageUrl}`);
    }

    // note: lately OneTrust uses shadow DOM (shadowRoot) for the actual clickable buttons,
    //   but we can only query the dummy buttons, which have zero width and are not clickable.
    //   Even Puppeteer's page.click() throws a "Node is either not clickable or not an Element"
    //   error for the dummy buttons.
    //   As long as the shadowRoot is open, we could climb into it and manipulate the shadow DOM
    //   buttons, but the shadowRoot can become closed at OneTrust's whim.
    //   Instead we use OneTrust's API to reject the cookies.
    //   https://developer.onetrust.com/onetrust/docs/javascript-api
    //   And we remove the lingering overlay manually, because OneTrust.Close() doesn't seem to work
    //   as advertised.
    const onetrustError = await catchResourceLoadErrors(options, async() => {
      const onetrustLogs = await browserPage.evaluate(() => {
        let logs = [];
        if (window.OneTrust) {
          if (window.OneTrust.RejectAll) {
            try {
              OneTrust.RejectAll();
              logs.push("OneTrust.RejectAll() was successful.");
              if (OneTrust.Close) {
                try {
                  OneTrust.Close();
                  logs.push("generatePagePdf(): OneTrust.Close() was successful.");
                } catch (onetrustCloseErr) {
                  logs.push("generatePagePdf(): OneTrust.Close() threw an error:", onetrustCloseErr);
                }
              }
              const cookieBannerHost = document.querySelector("body #cookie-banner-host");
              if (cookieBannerHost) {
                cookieBannerHost.remove();
              }
            } catch (onetrustRejectAllErr) {
              logs.push("generatePagePdf(): OneTrust.RejectAll() threw an error:", onetrustRejectAllErr);
            }
          } else {
            logs.push("generatePagePdf(): OneTrust detected, but has no RejectAll() function");
          }
        } else {
          logs.push("generatePagePdf(): no OneTrust object was detected");
        }
        return Promise.resolve(logs);
      });
      onetrustLogs.forEach((log) => {
        logger.verbose(`generatePagePdf(): ${log}`);
      });
    });

    if (options.leniency <= 3 && onetrustError) {
      throw new Error(`generatePagePdf(): there was an error during cookie consent handling in ${pageUrl}`);
    }

    logger.verbose("generatePagePdf(): removing not useful page elements");
    const pageElementRemovalError = await catchResourceLoadErrors(options, async() => {
      // removing a couple of sections which are not useful in a PDF
      const unusefulRemovalLogs = await browserPage.evaluate((isToCPage) => {
        const result = [];
        [
          "body #site-nav-embed", // header
          "body #site-footer-embed", // footer
        ].forEach((selector) => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            elements.forEach((element) => {
              element.remove();
            });
          } else {
            result.push(selector);
          }
        });
        if (!isToCPage) {
          [
            "body nav ~ div > div:has(> hr)", // horizontal ruler at the bottom of main page content
          ].forEach((selector) => {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              elements.forEach((element) => {
                element.remove();
              });
            } else {
              result.push(`could not find any element for the "${selector}" CSS selector (this might not be normal)`);
            }
          });
          // The "Customised support" & "Sign in" DIV.
          // Note: occasionally this is rendered with a slight delay
          //   (i.e. the first querySelector() call doesn't find it),
          //   thus we try to wait for it at most 5 seconds (i.e. 50 * 100ms).
          // This is not ideal, but I couldn't tell what the exact trigger is,
          // i.e. what should we check or wait for.
          const articleSelector = "body article";
          return new Promise((resolve) => {
            let articleCheckCount = 50;
            const intervalID = setInterval(() => {
              const articles = Array.from(document.querySelectorAll(articleSelector));
              if (articles.length > 0) {
                for (const article of articles) {
                  let ancestor = article.parentElement;
                  let goodArticle = true;
                  while (ancestor) {
                    const tagNameL = ancestor.tagName.toLowerCase();
                    if (tagNameL == "body") {
                      break;
                    } else if (tagNameL !== "div") {
                      result.push(`looking for "${articleSelector}" selector (${articleCheckCount}), not good element, found a non-div (${ancestor.tagName}) elemnt among its ancestors`);
                      goodArticle = false;
                      break;
                    }
                    ancestor = ancestor.parentElement;
                  }
                  if (goodArticle) {
                    if (article.previousElementSibling) {
                      if (
                        article.previousElementSibling.tagName
                        && article.previousElementSibling.tagName.toUpperCase() == "DIV"
                      ) {
                        const buttonCount = article.previousElementSibling.querySelectorAll("button").length;
                        if (buttonCount == 1) {
                          result.push(`looking for "${articleSelector}" selector (${articleCheckCount}), found a matching element and removed it`);
                          article.previousElementSibling.remove();
                          clearInterval(intervalID);
                          resolve(result);
                        } else {
                          if (buttonCount == 0) {
                            result.push(`looking for "${articleSelector}" selector (${articleCheckCount}), previousElementSibling doesn't have a button`);
                          } else {
                            result.push(`looking for "${articleSelector}" selector (${articleCheckCount}), previousElementSibling has too many buttons (${buttonCount})`);
                          }
                        }
                      } else {
                        result.push(`looking for "${articleSelector}" selector (${articleCheckCount}), previousElementSibling is not a DIV`);
                      }
                    } else {
                      result.push(`looking for "${articleSelector}" selector (${articleCheckCount}), no previousElementSibling`);
                    }
                    break;
                  }
                };
              } else {
                result.push(`looking for "${articleSelector}" selector (${articleCheckCount}), no matching elements`);
              }
              articleCheckCount--;
              if (articleCheckCount == 0) {
                clearInterval(intervalID);
                resolve(result);
              }
            }, 100);
          });
        } else {
          return Promise.resolve(result);
        }
      }, isToCPage);
      unusefulRemovalLogs.forEach((log) => {
        logger.verbose(`generatePagePdf(): ${log}`);
      });
    });

    if (options.leniency <= 2 && pageElementRemovalError) {
      throw new Error(`generatePagePdf(): there was an error during element removal in ${pageUrl}`);
    }

    // Iframes with a non-empty "src" are usually 3rd party stuff that we don't need in a PDF.
    const iframeRemovalError = await catchResourceLoadErrors(options, async() => {
      const iframeSrcs = await browserPage.evaluate(() => {
        const result = [];
        document.querySelectorAll("body iframe").forEach((iframe) => {
          if (iframe && iframe.src && iframe.src.length > 0) {
            result.push(iframe.src);
            iframe.remove();
          }
        });
        return Promise.resolve(result);
      });
      iframeSrcs.forEach((src) => {
        logger.verbose(`generatePagePdf(): removed iframe with an src of "${src}"`);
      });
    });

    if (options.leniency <= 1 && iframeRemovalError) {
      throw new Error(`generatePagePdf(): there was an error after iframe removal from ${pageUrl}`);
    }

    // We're now pretty much finished and ready to save the page as a PDF.
    // The browserPage.pdf() call (by default) waits for all fonts to be loaded,
    // but according to documentation:
    // "This might require activating the page using Page.bringToFront()
    //  if the page is in the background."
    // We haven't put the page into the background, but just in case ...
    // we'll try to bring it to the front (i.e. activate tab, etc.).
    logger.verbose("generatePagePdf(): bringing page/tab to front");
    browserPage.bringToFront();
    
    const waitForIdleAfterDomModificationsError = await catchResourceLoadErrors(options, async() => {
      logger.verbose("generatePagePdf(): waiting for network requests to go idle after DOM manipulations");
      const start4 = Date.now();
      await browserPage.waitForNetworkIdle({ concurrency: options.idleConcurrency, timeout: options.timeout });
      logger.verbose(`generatePagePdf(): wait is finished in ${ (Date.now() - start4) / 1000 }s`);
    });

    if (options.leniency == 0 && waitForIdleAfterDomModificationsError) {
      throw new Error(`generatePagePdf(): there was an error while waiting for network requests to go idle after DOM manipulations for ${pageUrl}`);
    }

    if (options.pageErrorTextPattern && options.pageErrorTextPattern.length > 0) {
      for (const text of options.pageErrorTextPattern) {
        const searchString = text.replaceAll("'", "");
        logger.verbose(`generatePagePdf(): looking for page error text pattern "${searchString}"`);
        const elements = await browserPage.$$(`xpath/.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${searchString}')]`);
        if (elements && elements.length > 0) {
          elements.forEach((e) => e.dispose());
          throw new Error(`generatePagePdf(): found page error text pattern "${searchString}" before PDF rendering`);
        }
      };
    }

    // save PDF of the page
    logger.verbose("generatePagePdf(): generating PDF");
    if (typeof pdfFilePath !== "undefined") {
      const start = Date.now();
      try {
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
      } catch (pdfGenError) {
        // Sometimes this browserPage.pdf() call times out.
        // According to its documentation this call waits
        // for document.fonts.ready to resolve.
        // So we'll check this here.
        const isFontsReady = await browserPage.evaluate(async() => {
          const isResolved = await Promise.race([
            document.fonts.ready.then(() => true, () => true),
            Promise.resolve(false)
          ]);
          return Promise.resolve(isResolved);
        });
        logger.error(`generatePagePdf(): browserPage.pdf() threw an error, checking if document.fonts.ready is resolved: ${isFontsReady}`);
        throw pdfGenError;
      }
      logger.verbose(`generatePagePdf(): PDF saved in ${ (Date.now() - start) / 1000 }s`);
    }
  
    // at this stage we consider the page-to-PDF process a success
    logger.verbose("generatePagePdf(): pdf generation was a success");
  } catch (pageError) {
    logger.error(`generatePagePdf(): error for ${pageUrl}: ${pageError.message}`);
    retObj.pageLoadError = true;
  }

  logger.verbose("generatePagePdf(): end");
  return retObj;
}
