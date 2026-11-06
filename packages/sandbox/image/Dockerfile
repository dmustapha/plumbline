# File: packages/sandbox/image/Dockerfile
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}
COPY harness.py /opt/plb/harness.py
COPY plumbline_sdk /opt/plb/plumbline_sdk
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp LANG=C.UTF-8
USER 65534:65534
WORKDIR /tmp
ENTRYPOINT ["python", "-I", "/opt/plb/harness.py"]
