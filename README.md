EncryptedGist
=============

Client-side encrypted plaintext editor that can persist/sync with GitHub Gists. All text is synchronized in an [encrypted](http://bitwiseshiftleft.github.io/sjcl/) state. I had a similar use case to [SDEES](https://news.ycombinator.com/item?id=12441302) ([Code on GitHub](https://github.com/schollz/sdees)), but needed a zero-install, browser-based solution.

[Try it!](https://srpeck.github.io/encryptedgist/index.html)

The editor is customized to my personal usage - CodeMirror in Vim mode for pure plaintext notetaking across multiple fixed-configuration machines (VDI, etc.). Often this includes confidential notes that I do not want to share with Google/Microsoft/GitHub, hence SJCL client-side encryption. Depending on your usage, you may want to inline everything in a single HTML file and/or add localStorage for offline/single-machine use, similar to [Encrypted](https://github.com/srpeck/encrypted).

![](demo.gif)
