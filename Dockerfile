FROM node:20-alpine

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source files
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Environment variables with defaults
ENV PORT=3000
ENV NODE_ENV=production

# Start the application
CMD ["node", "src/server.js"]
