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
