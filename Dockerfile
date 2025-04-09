FROM node:22.14.0-alpine3.21

# Update package index,
# install essential packages (including Chromium),
# update TLS root certificates.
RUN apk update \
  && apk add --no-cache \
    ca-certificates \
    tzdata \
    # Chromium version must be supported by the given Puppeteer version.
    # https://pptr.dev/supported-browsers
    # Since distros' Chromium package is continuously upgraded even
    # including major version upgrades (within the same Alpine patch version!!!),
    # the only solution is to keep Puppeteer's version updated all the time.
    # Note: we use Alpine's Chromium because allegedly the version downloaded
    # by Puppeteer doesn't work in Alpine.
    chromium \
    # Without SwiftShader (or the "--disable-gpu" switch) the upgrade from
    # Chromium 126.* to 128.* broke Chromium on Arm64 CPUs. The renderer
    # process would get stuck with 100% CPU load.
    chromium-swiftshader \
    nss \
    ghostscript \
    freetype \
    harfbuzz \
    msttcorefonts-installer \
    font-carlito \
    font-freefont \
    font-liberation \
    font-liberation-sans-narrow \
    font-noto-cjk \
    font-noto-cjk-extra \
    font-opensans \
    font-roboto \
    font-tlwg \
  && update-ca-certificates \
  && update-ms-fonts

# Puppeteer downloaded Chromium will not work on Alpine (allegedly).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true" \
  PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium-browser"

COPY ./bin/ /app/bin/
COPY ./lib/ /app/lib/
COPY ./index.js ./package*.json ./Dockerfile ./CHANGELOG.md ./README.md ./LICENSE /app/

# Create user, set owner and permissions
RUN adduser -D -g "" appuser \
  && mkdir /work \
  && chown -R appuser:appuser /app /work \
  && chmod -R a+rX,go-w /app /work \
  && chmod -R a+x /app/bin \
  && chmod a+w /work

# Cleanup
RUN rm -rf /var/cache/apk/* \
  /root/.node-gyp \
  /usr/share/man \
  /tmp/*

USER appuser
RUN cd /app \
  && npm install \
  && chmod -R a+rX /app \
  && rm -rf /home/appuser/.npm

WORKDIR /work
ENTRYPOINT [ "/app/bin/entrypoint.sh", "/app/bin/pdfgen4vcman-cli.js", "--browser-long-option", "no-sandbox" ]
CMD [ "--help" ]
