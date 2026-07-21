ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
