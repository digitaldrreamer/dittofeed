FROM temporalio/web:1.13.0

ENTRYPOINT ["/bin/sh", "-c", "TEMPORAL_GRPC_ENDPOINT=$TEMPORAL_GRPC_HOST:8233 node server.js"]
