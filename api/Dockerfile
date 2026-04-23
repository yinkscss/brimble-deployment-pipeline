FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates unzip gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*
RUN curl -sSL https://railpack.com/install.sh | sh

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3001
CMD ["npm", "run", "dev"]
