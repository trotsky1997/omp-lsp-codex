export const CLIENT_CAPABILITIES = {
    textDocument: {
        synchronization: {
            didSave: true,
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
        },
        hover: {
            contentFormat: ["markdown", "plaintext"],
            dynamicRegistration: false,
        },
        signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: {
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
            },
        },
        definition: {
            dynamicRegistration: false,
            linkSupport: true,
        },
        typeDefinition: {
            dynamicRegistration: false,
            linkSupport: true,
        },
        implementation: {
            dynamicRegistration: false,
            linkSupport: true,
        },
        callHierarchy: { dynamicRegistration: false },
        completion: {
            dynamicRegistration: false,
            contextSupport: true,
            completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["detail", "documentation"] } },
        },
        references: {
            dynamicRegistration: false,
        },
        documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: {
                valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
            },
        },
        rename: {
            dynamicRegistration: false,
            prepareSupport: true,
        },
        codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: {
                codeActionKind: {
                    valueSet: [
                        "quickfix",
                        "refactor",
                        "refactor.extract",
                        "refactor.inline",
                        "refactor.rewrite",
                        "source",
                        "source.organizeImports",
                        "source.fixAll",
                    ],
                },
            },
            resolveSupport: {
                properties: ["edit"],
            },
        },
        formatting: {
            dynamicRegistration: false,
        },
        rangeFormatting: {
            dynamicRegistration: false,
        },
        publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
            tagSupport: { valueSet: [1, 2] },
            codeDescriptionSupport: true,
            dataSupport: true,
        },
        diagnostic: {
            dynamicRegistration: true,
        },
    },
    window: {
        workDoneProgress: true,
    },
    workspace: {
        applyEdit: true,
        workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
            failureHandling: "abort",
        },
        configuration: true,
        workspaceFolders: true,
        symbol: {
            dynamicRegistration: false,
            symbolKind: {
                valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
            },
        },
        fileOperations: {
            dynamicRegistration: false,
            willCreate: false,
            didCreate: false,
            willRename: true,
            didRename: true,
            willDelete: false,
            didDelete: false,
        },
    },
};
