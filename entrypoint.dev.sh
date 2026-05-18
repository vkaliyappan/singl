#!/bin/sh
set -e

echo "Running database migrations..."
./node_modules/.bin/drizzle-kit migrate

echo "Starting development server..."
exec ./node_modules/.bin/next dev -H 0.0.0.0
