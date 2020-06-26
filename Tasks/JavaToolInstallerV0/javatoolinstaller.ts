import fs = require('fs');
import os = require('os');
import path = require('path');
import taskLib = require('azure-pipelines-task-lib/task');
import toolLib = require('azure-pipelines-tool-lib/tool');
import uuidV4 = require('uuid/v4');

import { AzureStorageArtifactDownloader } from "./AzureStorageArtifacts/AzureStorageArtifactDownloader";
import { JavaFilesExtractor } from './FileExtractor/JavaFilesExtractor';
import {BIN_FOLDER} from "./FileExtractor/JavaFilesExtractor";

const fileEndings = ['.tar', '.tar.gz', '.zip', '.7z', '.dmg', '.pkg'];
taskLib.setResourcePath(path.join(__dirname, 'task.json'));

async function run() {
    try {
        let versionSpec = taskLib.getInput('versionSpec', true);
        await getJava(versionSpec);
        taskLib.setResult(taskLib.TaskResult.Succeeded, taskLib.loc('SucceedMsg'));
    } catch (error) {
        taskLib.error(error.message);
        taskLib.setResult(taskLib.TaskResult.Failed, error.message);
    }
}

async function getJava(versionSpec: string) {
    const preInstalled: boolean = ("PreInstalled" === taskLib.getInput('jdkSourceOption', true));
    const fromAzure: boolean = ('AzureStorage' == taskLib.getInput('jdkSourceOption', true));
    const extractLocation: string = taskLib.getPathInput('jdkDestinationDirectory', true);
    const cleanDestinationDirectory: boolean = taskLib.getBoolInput('cleanDestinationDirectory', false);
    let compressedFileExtension: string;
    let jdkDirectory: string;
    const extendedJavaHome: string = `JAVA_HOME_${versionSpec}_${taskLib.getInput('jdkArchitectureOption', true)}`;

    toolLib.debug('Trying to get tool from local cache first');
    const localVersions: string[] = toolLib.findLocalToolVersions('Java');
    const version: string = toolLib.evaluateVersions(localVersions, versionSpec);

     // Clean the destination folder before downloading and extracting?
     if (cleanDestinationDirectory && taskLib.exist(extractLocation) && taskLib.stats(extractLocation).isDirectory) {
        console.log(taskLib.loc('CleanDestDir', extractLocation));

        // delete the contents of the destination directory but leave the directory in place
        fs.readdirSync(extractLocation)
        .forEach((item: string) => {
            const itemPath = path.join(extractLocation, item);
            taskLib.rmRF(itemPath);
        });
    }

    if (version) { //This version of Java JDK is already in the cache. Use it instead of downloading again.
        console.log(taskLib.loc('Info_ResolvedToolFromCache', version));
    } else if (preInstalled) {
        const preInstalledJavaDirectory: string | undefined = taskLib.getVariable(extendedJavaHome);
        if (preInstalledJavaDirectory === undefined) {
            throw new Error(taskLib.loc('JavaNotPreinstalled', versionSpec));
        }
        console.log(taskLib.loc('UsePreinstalledJava', preInstalledJavaDirectory));
        jdkDirectory = preInstalledJavaDirectory;
    } else if (fromAzure) { //Download JDK from an Azure blob storage location and extract.
        console.log(taskLib.loc('RetrievingJdkFromAzure'));
        const fileNameAndPath: string = taskLib.getInput('azureCommonVirtualFile', false);

        const azureDownloader = new AzureStorageArtifactDownloader(taskLib.getInput('azureResourceManagerEndpoint', true),
            taskLib.getInput('azureStorageAccountName', true), taskLib.getInput('azureContainerName', true), "");
        await azureDownloader.downloadArtifacts(extractLocation, '*' + fileNameAndPath);
        await sleepFor(250); //Wait for the file to be released before extracting it.

        if (checkFileEnding) {
            compressedFileExtension = getFileEnding(fileNameAndPath);
        } else {
            throw new Error(taskLib.loc('UnsupportedFileExtension'));
        }
        const extractSource = buildFilePath(extractLocation, compressedFileExtension, fileNameAndPath);
        jdkDirectory = await unpackJava(extractSource, compressedFileExtension, extractLocation, jdkDirectory);
    } else { //JDK is in a local directory. Extract to specified target directory.
        console.log(taskLib.loc('RetrievingJdkFromLocalPath'));
        if (checkFileEnding) {
            compressedFileExtension = getFileEnding(taskLib.getInput('jdkFile', true));
        } else {
            throw new Error(taskLib.loc('UnsupportedFileExtension'));
        }
        jdkDirectory = await unpackJava(taskLib.getInput('jdkFile', true), compressedFileExtension, extractLocation, jdkDirectory);
    }

    console.log(taskLib.loc('SetJavaHome', jdkDirectory));
    console.log(taskLib.loc('SetExtendedJavaHome', extendedJavaHome, jdkDirectory));
    taskLib.setVariable('JAVA_HOME', jdkDirectory);
    taskLib.setVariable(extendedJavaHome, jdkDirectory);
    toolLib.prependPath(path.join(jdkDirectory, BIN_FOLDER));
}

function sleepFor(sleepDurationInMillisecondsSeconds): Promise<any> {
    return new Promise((resolve, reeject) => {
        setTimeout(resolve, sleepDurationInMillisecondsSeconds);
    });
}

function buildFilePath(localPathRoot: string, fileEnding: string, fileNameAndPath: string): string {
    const fileName = fileNameAndPath.split(/[\\\/]/).pop();
    const extractSource = path.join(localPathRoot, fileName);

    return extractSource;
}

function checkFileEnding(file: string): boolean {
    for (const fileEnding of fileEndings) {
        if (file.endsWith(fileEnding)) {
            return true;  
        }
    }
    return false;
}

function getFileEnding(file: string): string {
    for (const fileEnding of fileEndings) {
        if (file.endsWith(fileEnding)) {
            return fileEnding;  
        }
    }
}

async function unpackJava(sourceFile: string, compressedFileExtension: string, extractLocation: string, jdkDirectory: string): Promise<string> {
    const javaFilesExtractor = new JavaFilesExtractor();
    if (compressedFileExtension === '.dmg' && os.platform() === 'darwin') {
        const VOLUMES_FOLDER = '/Volumes';

        // Using set because 'includes' array method requires tsconfig option "lib": ["ES2017"]
        const volumes: Set<string> = new Set(fs.readdirSync(VOLUMES_FOLDER));

        await attach(sourceFile);

        const newVolumes: string[] = fs.readdirSync(VOLUMES_FOLDER).filter(volume => !volumes.has(volume));
        if (newVolumes.length !== 1) {
            throw new Error(taskLib.loc('UnsupportedDMGArchiveStructure'));
        }

        let volumePath: string = path.join(VOLUMES_FOLDER, newVolumes[0]);
        let packages: string[] = fs.readdirSync(volumePath).filter(file => file.endsWith('.pkg'));

        let pkgPath: string;
        if (packages.length === 1) {
            pkgPath = path.join(volumePath, packages[0]);
        } else if (packages.length === 0) {
            throw new Error(taskLib.loc('NoPKGFile'));
        } else {
            throw new Error(taskLib.loc('SeveralPKGFiles'));
        }

        jdkDirectory = await installJDK(pkgPath);

        await detach(volumePath);
    }
    else if (compressedFileExtension === '.pkg' && os.platform() === 'darwin') {
        jdkDirectory = await installJDK(sourceFile);
    }
    else {
        jdkDirectory = await javaFilesExtractor.unzipJavaDownload(sourceFile, compressedFileExtension, extractLocation);
    }
    return jdkDirectory;
}

async function installJDK(pkgPath: string): Promise<string> {
    console.log(taskLib.loc('InstallJDK'));

    const JDK_FOLDER = '/Library/Java/JavaVirtualMachines';
    const JDK_HOME_FOLDER = 'Contents/Home';

    // Using set because 'includes' array method requires tsconfig option "lib": ["ES2017"]
    const JDKs: Set<string> = new Set(fs.readdirSync(JDK_FOLDER));

    await runScript(false, `sudo installer -package "${pkgPath}" -target /`, '');

    const newJDKs = fs.readdirSync(JDK_FOLDER).filter(jdkName => !JDKs.has(jdkName));

    if (newJDKs.length !== 1) {
        throw new Error(taskLib.loc('NewJDKIsNotInstalled'));
    }

    let jdkDirectory: string = path.join(JDK_FOLDER, newJDKs[0], JDK_HOME_FOLDER);
    return jdkDirectory;
}

async function attach(sourceFile: string): Promise<void> {
    console.log(taskLib.loc('AttachDiskImage'));
    await runScript(false, `sudo hdiutil attach "${sourceFile}"`, '');
}

async function detach(volumePath: string): Promise<void> {
    console.log(taskLib.loc('DetachDiskImage'));
    await runScript(false, `sudo hdiutil detach "${volumePath}"`, '');
}

async function runScript(failOnStderr: boolean, script: string, workingDirectory: string): Promise<any> {
    const tl = taskLib;
    
    try {
        // Write the script to disk.
        console.log(tl.loc('GeneratingScript'));
        tl.assertAgent('2.115.0');
        let tempDirectory = tl.getVariable('agent.tempDirectory');
        tl.checkPath(tempDirectory, `${tempDirectory} (agent.tempDirectory)`);
        let filePath = path.join(tempDirectory, uuidV4() + '.sh');
        await fs.writeFileSync(
            filePath,
            script, // Don't add a BOM. It causes the script to fail on some operating systems (e.g. on Ubuntu 14).
            { encoding: 'utf8' });

        // Print one-liner scripts.
        if (script.indexOf('\n') < 0 && script.toUpperCase().indexOf('##VSO[') < 0) {
            console.log(tl.loc('ScriptContents'));
            console.log(script);
        }

        // Create the tool runner.
        console.log('========================== Starting Command Output ===========================');
        let bash = tl.tool(tl.which('bash', true))
            .arg('--noprofile')
            .arg(`--norc`)
            .arg(filePath);
        let options = <any> {
            cwd: workingDirectory,
            failOnStdErr: false,
            errStream: process.stdout, // Direct all output to STDOUT, otherwise the output may appear out
            outStream: process.stdout, // of order since Node buffers it's own STDOUT but not STDERR.
            ignoreReturnCode: true
        };

        // Listen for stderr.
        let stderrFailure = false;
        const aggregatedStderr: string[] = [];
        if (failOnStderr) {
            bash.on('stderr', (data: Buffer) => {
                stderrFailure = true;
                // Truncate to at most 10 error messages
                if (aggregatedStderr.length < 10) {
                    // Truncate to at most 1000 bytes
                    if (data.length > 1000) {
                        aggregatedStderr.push(`${data.toString('utf8', 0, 1000)}<truncated>`);
                    } else {
                        aggregatedStderr.push(data.toString('utf8'));
                    }
                } else if (aggregatedStderr.length === 10) {
                    aggregatedStderr.push('Additional writes to stderr truncated');
                }
            });
        }

        // Run bash.
        let exitCode: number = await bash.exec(options);

        // Fail on exit code.
        if (exitCode !== 0) {
            tl.error(tl.loc('JS_ExitCode', exitCode));
        }

        // Fail on stderr.
        if (stderrFailure) {
            tl.error(tl.loc('JS_Stderr'));
            aggregatedStderr.forEach((err: string) => {
                tl.error(err);
            });
        }
    }
    catch (err) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'runScript() failed', true);
    }
}

run();
