FROM node:22-alpine

# Update packages of the base image,
# install essential packages (including Chromium),
# update TLS root certificates.
RUN apk update \
  && apk add --no-cache \
    ca-certificates \
    tzdata \
    chromium \
    ttf-freefont \
  && update-ca-certificates

# Puppeteer downloaded Chromium will not work on Alpine.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true" \
  PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium-browser"

COPY ./bin/ /app/bin/
COPY ./lib/ /app/lib/
COPY ./index.js ./package*.json ./README.md /app/

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
  /home/appuser/.npm \
  /tmp/*

USER appuser
RUN cd /app && npm install
WORKDIR /work
ENTRYPOINT [ "/app/bin/pdfgen4vcman-cli.js", "--browser-long-option", "no-sandbox" ]
CMD [ "--help" ]
