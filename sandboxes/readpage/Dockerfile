FROM alpine:3.24.2

RUN apk add --no-cache chromium-headless-shell py3-beautifulsoup4 python3

WORKDIR /app
COPY sandboxes/readpage/dump_dom.py /app/dump_dom.py
COPY sandboxes/readpage/flatten_dom.js /app/flatten_dom.js
COPY sandboxes/readpage/page_proxy.py /app/page_proxy.py
COPY sandboxes/readpage/connection_gate.py /app/connection_gate.py
COPY sandboxes/readpage/proxy_http.py /app/proxy_http.py
COPY sandboxes/readpage/web_addresses.py /app/web_addresses.py
COPY sandboxes/readpage/parse_dom.py /app/parse_dom.py
COPY sandboxes/readpage/endpoint.sh /app/endpoint.sh
# The backend's own files of the address ranges and of the exit codes it reads
# from the reader, so the reader and the backend use one copy of each.
COPY apps/backend/src/modules/tool/builtIn/web/blocked_address_ranges.json /app/blocked_address_ranges.json
COPY apps/backend/src/modules/tool/builtIn/web/page_reader_exit_codes.json /app/page_reader_exit_codes.json

# Run as a non-root user
RUN adduser -D -h /home/browser browser
USER browser

ENTRYPOINT ["sh", "/app/endpoint.sh"]
