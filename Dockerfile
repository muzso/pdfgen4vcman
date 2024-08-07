FROM node:22-alpine3.20

# Update packages of the base image,
# install essential packages (including Chromium),
# update TLS root certificates.
RUN apk update \
  && apk add --no-cache \
    ca-certificates \
    tzdata \
    ghostscript \
    # Chromium version must be supported by the given Puppeteer version.
    # https://pptr.dev/supported-browsers
    # We ensure this by fixing the base image (Alpine release version).
    chromium \
    freetype \
    harfbuzz \
    msttcorefonts-installer \
    font-carlito \
    font-noto-cjk \
    font-noto-cjk-extra \
    font-tlwg \
    font-liberation \
    font-liberation-sans-narrow \
    font-roboto \
  && update-ca-certificates \
  && update-ms-fonts

# Puppeteer downloaded Chromium will not work on Alpine.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true" \
  PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium-browser"

COPY ./bin/ /app/bin/
COPY ./lib/ /app/lib/
COPY ./index.js ./package*.json ./README.md ./LICENSE /app/

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
