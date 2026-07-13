# Python document parsing sidecar.
# Single-purpose service: receives a binary document over HTTP, returns
# clean markdown + structured metadata + extracted tables.
#
# Stack: FastAPI + MarkItDown (primary) + Unstructured (fallback for OCR/exotic formats).
# Image is debian-slim based to keep system deps (libreoffice, poppler, tesseract) available.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System dependencies needed by MarkItDown + Unstructured for office docs,
# PDFs (poppler), and OCR (tesseract). LibreOffice handles legacy .doc / .ppt.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    poppler-utils \
    tesseract-ocr \
    libmagic1 \
    pandoc \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app/ ./app/

# Run as a non-root user. LibreOffice/tesseract need a writable HOME, so
# --create-home gives appuser /home/appuser; /app is owned by appuser too.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
