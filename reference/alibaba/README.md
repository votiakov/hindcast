# Real production check — Alibaba's microservices

The Kubernetes reference ([../k8s](../k8s)) tests whole decisions on a system you can rebuild. This
one tests the calibration's foundation on telemetry nobody can rebuild: **Alibaba's production
microservices**, 12 hours of [cluster-trace-microservices-v2021](https://github.com/alibaba/clusterdata)
(calls per second, response time and CPU for every container, every minute).

## The check

The question every capacity or cost answer rests on: **given the traffic, how much CPU will a
service burn?** For the 60 busiest services (median 379 containers each,
6.2 million calls per second between them), `calibrate` — the same code that fits your
system — is fitted on the first 504 minutes and asked for each service's CPU
over the last 217, from its traffic alone. Two naive forecasts for comparison:

- **per request** — CPU per call held at its training average (no idle baseline);
- **an hour ago** — the CPU the service burned an hour earlier.

## Results

Median error of the CPU forecast, per service, on the 217 minutes held out:

| minutes | services | the model | per request | an hour ago |
|---|---|---|---|---|
| all | 60 | 7.4% | 7.6% | 7.4% |
| traffic moved ≥15% from an hour before | 44 | **5.9%** | 11.0% | 13.2% |
| traffic above anything the training saw | 14 | **12.9%** | 30.4% | — |

On a steady afternoon every forecast is right within ~7%: production load changes slowly, and
"the same as an hour ago" is hard to beat. The forecasts that matter are the ones where the load
moves — and there the calibrated model halves the error of both naive answers: 5.9%
against 11.0% and 13.2% when traffic moved, 12.9% against
30.4% at loads above anything in training (the launch-day case). The difference is the idle baseline:
services whose CPU barely follows their traffic (background work, caches, GC) are where a
per-request ratio goes furthest wrong (78.8% for one service whose load swung ×4.5; the
model 15.9%). 48 of 60 services are within 10% overall.

What this does not check: latency. The trace publishes the mean response time per container, not
percentiles, and these services run far below saturation — there is no queueing to predict.
Latency near the limit is what the Kubernetes reference and the step load tests check.

## Running it

```sh
sh reference/alibaba/fetch.sh /tmp/alibaba        # streams ~35 GB, keeps ~20 MB
npx tsx reference/alibaba/validate.ts /tmp/alibaba --top 60
```

`results.json` holds every service's numbers. The trace asks that publications cite its paper
(Luo et al., *Characterizing Microservice Dependency and Performance: Alibaba Trace Analysis*,
SoCC 2021); it is not redistributed here, only these aggregate results.
