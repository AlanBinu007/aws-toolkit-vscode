/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import * as vscode from 'vscode'
import { readdir, readdirSync, statSync, writeFileSync } from 'fs-extra'
import { isImageLambdaConfig, NodejsDebugConfiguration } from '../../../lambda/local/debugConfiguration'
import { RuntimeFamily } from '../../../lambda/models/samLambdaRuntime'
import * as pathutil from '../../../shared/utilities/pathUtils'
import { ExtContext } from '../../extensions'
import { findParentProjectFile } from '../../utilities/workspaceUtils'
import { DefaultSamLocalInvokeCommand, WAIT_FOR_DEBUGGER_MESSAGES } from '../cli/samCliLocalInvoke'
import { invokeLambdaFunction, makeInputTemplate, waitForPort } from '../localLambdaRunner'
import { SamLaunchRequestArgs } from './awsSamDebugger'
import { getLogger } from '../../logger'
import { ChildProcess } from '../../../shared/utilities/childProcess'

/**
 * Launches and attaches debugger to a SAM Node project.
 */
export async function invokeTypescriptLambda(
    ctx: ExtContext,
    config: NodejsDebugConfiguration
): Promise<NodejsDebugConfiguration> {
    config.samLocalInvokeCommand = new DefaultSamLocalInvokeCommand([WAIT_FOR_DEBUGGER_MESSAGES.NODEJS])
    // eslint-disable-next-line @typescript-eslint/unbound-method
    config.onWillAttachDebugger = waitForPort
    const onAfterBuild = () => compileTypeScript(config)
    const c = (await invokeLambdaFunction(ctx, config, onAfterBuild)) as NodejsDebugConfiguration
    return c
}

export async function getSamProjectDirPathForFile(filepath: string): Promise<string> {
    const packageJsonPath = await findParentProjectFile(vscode.Uri.parse(filepath), /^package\.json$/)
    if (!packageJsonPath) {
        throw new Error(`Cannot find package.json for: ${filepath}`)
    }

    return path.dirname(packageJsonPath.fsPath)
}

/**
 * Gathers and sets launch-config info by inspecting the workspace and creating
 * temp files/directories as needed.
 *
 * Does NOT execute/invoke SAM, docker, etc.
 */
export async function makeTypescriptConfig(config: SamLaunchRequestArgs): Promise<NodejsDebugConfiguration> {
    if (!config.baseBuildDir) {
        throw Error('invalid state: config.baseBuildDir was not set')
    }
    if (!config.codeRoot) {
        // Last-resort attempt to discover the project root (when there is no
        // `launch.json` nor `template.yaml`).
        config.codeRoot = pathutil.normalize(
            await getSamProjectDirPathForFile(config?.templatePath ?? config.documentUri!!.fsPath)
        )
        if (!config.codeRoot) {
            // TODO: return error and show it at the caller.
            throw Error('missing launch.json, template.yaml, and failed to discover project root')
        }
    }
    let localRoot: string | undefined
    let remoteRoot: string | undefined
    config.codeRoot = pathutil.normalize(config.codeRoot)

    // Always generate a temporary template.yaml, don't use workspace one directly.
    config.templatePath = await makeInputTemplate(config)

    const isImageLambda = isImageLambdaConfig(config)

    if (isImageLambda && !config.noDebug) {
        config.containerEnvVars = {
            NODE_OPTIONS: `--inspect-brk=0.0.0.0:${config.debugPort} --max-http-header-size 81920`,
        }
    }

    // if provided, use the user's mapping instead
    if (config.lambda?.pathMappings !== undefined && config.lambda.pathMappings.length > 0) {
        const mappings = config.lambda.pathMappings
        if (mappings.length !== 1) {
            getLogger().warn(
                'This language only supports a single path mapping entry. Taking the first entry in the list.'
            )
        }
        localRoot = mappings[0].localRoot
        remoteRoot = mappings[0].remoteRoot
    }

    //  Make a node launch-config from the generic config.
    const nodejsLaunchConfig: NodejsDebugConfiguration = {
        ...config, // Compose.
        type: 'node',
        request: config.noDebug ? 'launch' : 'attach',
        runtimeFamily: RuntimeFamily.NodeJS,
        preLaunchTask: undefined,
        address: 'localhost',
        port: config.debugPort ?? -1,
        // in theory, roots should never be undefined for node
        localRoot: localRoot ?? config.codeRoot,
        remoteRoot: remoteRoot ?? '/var/task',
        protocol: 'inspector',
        // Stop at first user breakpoint, not the runtime bootstrap file.
        stopOnEntry: config.stopOnEntry === undefined ? false : !!config.stopOnEntry,
        skipFiles: ['/var/runtime/node_modules/**/*.js', '<node_internals>/**/*.js'],
    }

    return nodejsLaunchConfig
}

/**
 * Recursively searches directory and all nested directories until a TypeScript file is found
 * @param dir Directory to search
 * @returns true if at least one TypeScript file exists
 */
function hasTypeScriptFilesRecursive(dir:string): boolean {
    const files = readdirSync(dir)

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        if (file.substr(-3) === '.ts'){
            return true
        }
    
        if(statSync(path.join(dir, file)).isDirectory()){
            if(hasTypeScriptFilesRecursive(path.join(dir, file))) {
                return true
            }
        }
    }        
    return false
}

/**
 * For non-template debug configs (target = code), compile the project
 * using a temporary default tsconfig.json file.
 */
async function compileTypeScript(config: NodejsDebugConfiguration): Promise<void> {
    // Compile step for TS projects from source code
    if (config.invokeTarget.target === 'code') {
        const samBuildOutputAppRoot = path.join(config.baseBuildDir!, 'output', 'awsToolkitSamLocalResource')
        const tsconfigPath = path.join(samBuildOutputAppRoot, 'tsconfig.json')
        if ((await readdir(config.codeRoot)).includes('tsconfig.json') || hasTypeScriptFilesRecursive(config.codeRoot)) {
        //  This default config is a modified version from the AWS Toolkit for JetBrain's tsconfig file. https://github.com/aws/aws-toolkit-jetbrains/blob/feature/typescript/jetbrains-ultimate/src/software/aws/toolkits/jetbrains/services/lambda/nodejs/NodeJsLambdaBuilder.kt 
            const defaultTsconfig = {
                "compilerOptions": {
                    "target": "es6",
                    "module": "commonjs",
                    "typeRoots": [
                    "node_modules/@types"
                    ],                       
                    "types": [
                    "node"
                    ],
                    "rootDir": ".",
                    "sourceMap": true,
                }
            }
            const compileCommand = ['tsc', '--project', samBuildOutputAppRoot]
            try {
                writeFileSync(tsconfigPath, JSON.stringify(defaultTsconfig))
                getLogger('channel').info('Compiling TypeScript')
                await new ChildProcess(true, compileCommand.join(' ')).run()    
            } catch (error) {
                getLogger('channel').error(`Compile Error: ${error}`)
                throw Error('Failed to compile typescript Lambda')
            }
        }
    }
}
