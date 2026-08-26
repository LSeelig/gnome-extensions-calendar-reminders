NAME=calendar-reminders
DOMAIN=donnybeelo.github.com

.PHONY: all pack install clean

all: dist/extension.js

node_modules: package.json
	bun install

dist/extension.js: node_modules extension.ts parser.ts
	bunx tsc

$(NAME).zip: dist/extension.js
	@cp metadata.json dist/
	@(cd dist && zip ../$(NAME).zip -9r .)

pack: $(NAME).zip

install: $(NAME).zip
	@touch ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@mv dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)

clean:
	@rm -rf dist node_modules $(NAME).zip
