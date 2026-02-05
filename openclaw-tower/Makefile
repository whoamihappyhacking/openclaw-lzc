.PHONY: build clean deps

BINARY=tower
GOOS?=$(shell go env GOOS)
GOARCH?=$(shell go env GOARCH)

build: deps
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -ldflags="-s -w" -o $(BINARY) .

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o $(BINARY)-linux-amd64 .

deps:
	go mod tidy

clean:
	rm -f $(BINARY) $(BINARY)-linux-amd64
