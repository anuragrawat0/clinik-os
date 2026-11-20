FROM golang:1.24-alpine AS build

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ENV CGO_ENABLED=0

RUN mkdir -p /out \
  && GOBIN=/out go install github.com/minio/minio@${MINIO_VERSION}

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata \
  && mkdir -p /data

COPY --from=build /out/minio /usr/bin/minio

VOLUME ["/data"]
EXPOSE 9000 9001

ENTRYPOINT ["/usr/bin/minio"]
