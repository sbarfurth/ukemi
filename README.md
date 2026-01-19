# ukemi

This is a Visual Studio Code extension to interact with the
[Jujutsu (jj) version control system](https://github.com/jj-vcs/jj).

This extension is a fork of [jjk](https://github.com/keanemind/jjk). You can
find an overview of all basic features its
[README](https://github.com/sbarfurth/jjk/blob/main/README.md).

## Contributing

Feel free to contribute to the extension.

### Requirements

* [Node.js](https://nodejs.org/en) 22
* [zig](https://ziglang.org/) 15.2

### Setup

Begin by installing npm depdencies.

```console
npm install
```

Afterwards, you can build the extension sources and run tests.

```console
npm run build
npm run test
```

Running tests requires a display. You may see errors if you do not have a
display (e.g. if you're developing remotely).

> Missing X server or $DISPLAY

It should be possible to bridge this gap with
[Xvfb](https://en.wikipedia.org/wiki/Xvfb). You can create a virtual screen
with Xvfb and point the `DISPLAY` environment variable to it for the test.

Start a virtual display. This will run in the background.

```console
Xvfb :99 -screen 0 1280x1024x24 &
```

Then specify the `DISPLAY` environment variable when running tests.

```console
DISPLAY=:99 npm test
```

The Electron docs have
[slightly more detailed guidance](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci).

### Testing in VSCode

You can package the extension to a VSIX file locally and test this directly in
your VSCode installation.

Begin by packaging the extension.

```console
npx @vscode/vsce package
```

This produces `ukemi-<version>.vsix` in the root of the repository.

Once you have this file, follow the
[instructions from the official VSCode docs](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
to install the extension from it.
