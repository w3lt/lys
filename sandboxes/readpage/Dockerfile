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
# Loads both files with the reader's own code, which refuses some files the
# backend accepts, such as a range with host bits set, so such a change fails
# the image build instead of every read. The import also fails the build when
# a reader module does not parse with the image's Python.
RUN python3 -B -c "import dump_dom, web_addresses; web_addresses.load_blocked_address_ranges(web_addresses.BLOCKED_ADDRESS_RANGES_PATH); dump_dom.load_blocked_address_exit_code(dump_dom.EXIT_CODES_PATH)"

# Run as a non-root user
RUN adduser -D -h /home/browser browser
USER browser

ENTRYPOINT ["sh", "/app/endpoint.sh"]
