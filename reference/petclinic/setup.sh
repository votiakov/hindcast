#!/bin/sh
# The OpenTelemetry Java agent is not committed (25 MB); fetch the pinned release.
cd "$(dirname "$0")" && mkdir -p otel && curl -sSL -o otel/opentelemetry-javaagent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.9.0/opentelemetry-javaagent.jar
