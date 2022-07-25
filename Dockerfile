FROM node:16-alpine

COPY ./package.json /package.json
COPY ./package-lock.json /package-lock.json

RUN apk add --update openssh

RUN npm i

COPY ./main.js /main.js
RUN ["chmod", "+x", "/main.js"]

ENTRYPOINT [ "node", "/main.js" ]