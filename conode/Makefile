CONTAINER = conode
IMAGE_NAME = c4dt/$(CONTAINER)
TAG = dev-$(shell date +%y%m%d)

# -s -w are for smaller binaries
# -X compiles the git tag into the binary
ldflags=-s -w -X main.gitTag=$(TAG)

all: docker

# Use this target to build from local source
docker: clean build/Dockerfile build/conode
	test -d cothority || git clone --depth 1 -b personhood_1904 https://github.com/dedis/cothority
	docker build -t $(IMAGE_NAME):$(TAG) -f build/Dockerfile build
	docker tag $(IMAGE_NAME):$(TAG) $(IMAGE_NAME):dev

newdb:
	@echo "Compiling binaries"; \
	GO111MODULE=on go build -o build/conode; \
	cd cothority; \
		go build -o ../bcadmin ./byzcoin/bcadmin; \
		go build -o ../phapp ./personhood/phapp
	@echo "Starting nodes"; \
	( cd build; COTHORITY_ALLOW_INSECURE_ADMIN=true ./run_nodes.sh -v 2 -t -n 4 -s -d conodes > /dev/null & )
	@echo "Waiting for nodes to start up"; sleep 10; \
	echo "Creating new ByzCoin and printing out important variables"; echo; \
	rm -f *.cfg; \
	( ./bcadmin -c . create build/conodes/public.toml --interval 500ms; \
	  ./phapp spawner bc-* key-*; \
	  ./bcadmin latest --bc bc-*; \
	  ./bcadmin key -print key-* ) | egrep "^(ByzCoin|Admin|Private)" | tee variables.txt
	@echo; echo "Shutting down conodes"; pkill -f conode; rm build/conodes/running

docker_run:
	docker run -it -p 7770-7777:7770-7777 --name $(CONTAINER) $(IMAGE_NAME):dev

docker_stop:
	docker stop $(CONTAINER)

docker_start:
    docker start $(CONTAINER)

docker_clean:
	docker kill $(CONTAINER) || echo nothing to stop
	docker image ls $(IMAGE_NAME) -q | xargs docker rmi -f || echo done

# The suffix on conode exe is the result from: echo `uname -s`.`uname -m`
# so that we can find the right one in the wrapper script.
# This is in it's own rule because the Docker build needs it also.
build/conode:
	GO111MODULE=on GOOS=linux GOARCH=amd64 go build -ldflags="$(ldflags)" -o $@

clean:
	rm -rf build/conode
