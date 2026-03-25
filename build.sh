#!/bin/bash

echo "Installing system dependencies..."
apt-get update
apt-get install -y espeak-ng

echo "Installing Node dependencies..."
npm install

echo "Running database migration..."
node scripts/migrate.js

echo "Build complete!"
