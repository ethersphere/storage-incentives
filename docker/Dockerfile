FROM node:20.11.1-alpine as build

ENV NODE_ENV=production

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --prod --frozen-lockfile --verbose

COPY s3/package.json s3/yarn.lock ./s3/
RUN cd s3 && yarn install --prod --frozen-lockfile --verbose

COPY . ./
RUN yarn hardhat compile
RUN cd s3 && yarn hardhat compile

FROM node:20.11.1-alpine

ENV NODE_ENV=production
ENV WALLET_SECRET=4663c222787e30c1994b59044aa5045377a6e79193a8ead88293926b535c722d

RUN apk add --no-cache curl bash

WORKDIR /app

COPY --from=build /app .

CMD ["sh", "-c", "/app/docker/deploy.sh"]
