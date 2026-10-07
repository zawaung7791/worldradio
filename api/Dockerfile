FROM node:22-alpine
WORKDIR /app
COPY server.js .
# /data holds the shared dead-station list; create it owned by the unprivileged user
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
