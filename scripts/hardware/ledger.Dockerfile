FROM ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools@sha256:0ed357a6f66a1df949649803ea79e5a224f3f551a496adb3b73af22088781452
ENV BOLOS_SDK=/opt/nanos-secure-sdk
WORKDIR /app
RUN git clone https://github.com/LedgerHQ/app-monero.git . && git checkout 7cf472121485d3ea781a241571fbdd8d94b7fc4d && make DEBUG=0 -j4
RUN python -m venv --system-site-packages /opt/rujira-speculos && /opt/rujira-speculos/bin/pip install speculos==0.23.0
EXPOSE 5000
ENTRYPOINT ["/opt/rujira-speculos/bin/speculos", "--model", "nanos", "--display", "headless", "--seed", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "/app/build/nanos/bin/app.elf"]
