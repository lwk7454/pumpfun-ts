# Use the official Deno image
FROM denoland/deno:latest

# Create and switch to a working directory
WORKDIR /app

# Copy the watcher script into the container
COPY src/main.ts .

# By default, Deno caches dependencies automatically; if you have extra deps,
# e.g. import_map.json, you'd copy that here as well.

# Set any environment variables for watchers here or override via docker-compose.
# ENV INFLUXDB_URL=http://localhost:8086
# ENV INFLUXDB_TOKEN=MY-TOKEN
# ENV INFLUXDB_ORG=my-org
# ENV INFLUXDB_BUCKET=my-bucket

# Final command to run the watcher:
CMD ["deno", "run", "-A", "main.ts"]
