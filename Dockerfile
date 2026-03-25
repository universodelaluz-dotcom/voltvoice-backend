FROM node:20-slim

# Install system dependencies including espeak-ng
RUN apt-get update && \
    apt-get install -y espeak-ng && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Copy application files
COPY . .

# Create tmp directory
RUN mkdir -p tmp

# Run migrations
RUN node scripts/migrate.js

# Expose port
EXPOSE 8000

# Start server
CMD ["node", "server.js"]
