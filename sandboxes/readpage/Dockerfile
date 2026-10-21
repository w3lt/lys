FROM alpine:3.24.2

RUN apk add --no-cache chromium-headless-shell py3-beautifulsoup4 python3

WORKDIR /app
COPY sandboxes/readpage/dump_dom.py /app/dump_dom.py
COPY sandboxes/readpage/flatten_dom.js /app/flatten_dom.js
COPY sandboxes/readpage/parse_dom.py /app/parse_dom.py
COPY sandboxes/readpage/endpoint.sh /app/endpoint.sh

# Run as a non-root user
RUN adduser -D -h /home/browser browser
USER browser

ENTRYPOINT ["sh", "/app/endpoint.sh"]
