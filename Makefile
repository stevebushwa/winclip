UUID    = winclip@stevebushwa.github.io
EXTRAS  = store.js clipboardMonitor.js overlay.js tabs.js imageUtil.js \
          gifSearch.js clipboardSource.js glyphTab.js uiHelpers.js \
          kaomojiData.js symbolData.js \
          paste.js gifScanner.js emojiData.js LICENSE
ZIP     = dist/$(UUID).shell-extension.zip

.PHONY: pack install clean

pack:
	@mkdir -p dist
	gnome-extensions pack src $(addprefix --extra-source=,$(EXTRAS)) \
	    --out-dir=dist --force

install: pack
	gnome-extensions install $(ZIP) --force
	@echo "Installed. Log out and back in to load it."

clean:
	rm -rf dist
