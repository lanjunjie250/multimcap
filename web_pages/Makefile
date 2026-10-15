.PHONY: build test preview package
build:
	node scripts/build.mjs
test:
	node test/recording.test.mjs
preview:
	node scripts/preview.mjs
package: build
	python3 scripts/package.py
