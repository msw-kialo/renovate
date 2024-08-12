import is from '@sindresorhus/is';
import { quote } from 'shlex';
import { TEMPORARY_ERROR } from '../../../../constants/error-messages';
import { logger } from '../../../../logger';
import { exec } from '../../../../util/exec';
import type { ExecOptions, ToolConstraint } from '../../../../util/exec/types';
import { getSiblingFileName, readLocalFile } from '../../../../util/fs';
import { Result } from '../../../../util/result';
import type {
  PackageDependency,
  UpdateArtifact,
  UpdateArtifactsResult,
  Upgrade,
} from '../../types';
import { type PyProject, UvLockfileSchema } from '../schema';
import { depTypes, parseDependencyList } from '../utils';
import type { PyProjectProcessor } from './types';

const uvUpdateCMD = 'uv lock --python-preference only-system';

export class UvProcessor implements PyProjectProcessor {
  process(project: PyProject, deps: PackageDependency[]): PackageDependency[] {
    const uv = project.tool?.uv;
    if (is.nullOrUndefined(uv)) {
      return deps;
    }

    deps.push(
      ...parseDependencyList(
        depTypes.uvDevDependencies,
        uv['dev-dependencies'],
      ),
    );

    // TODO: Parse uv.sources and adapt deps.*.registryUrls:
    // const uvSource = uv.source;
    // if (is.nullOrUndefined(uvSource)) {
    //   return deps;
    // }

    // // add pypi default url, if there is no source declared with the name `pypi`. https://daobook.github.io/uv/pyproject/tool-uv/#specify-other-sources-for-finding-packages
    // const containsPyPiUrl = uvSource.some((value) => value.name === 'pypi');
    // const registryUrls: string[] = [];
    // if (!containsPyPiUrl) {
    //   registryUrls.push(PypiDatasource.defaultURL);
    // }
    // for (const source of uvSource) {
    //   registryUrls.push(source.url);
    // }
    // for (const dep of deps) {
    //   dep.registryUrls = [...registryUrls];
    // }

    return deps;
  }

  async extractLockedVersions(
    project: PyProject,
    deps: PackageDependency[],
    packageFile: string,
  ): Promise<PackageDependency[]> {
    const lockFileName = getSiblingFileName(packageFile, 'uv.lock');
    const lockFileContent = await readLocalFile(lockFileName, 'utf8');
    if (lockFileContent) {
      const lockFileMapping = Result.parse(
        lockFileContent,
        UvLockfileSchema.transform(({ lock }) => lock),
      ).unwrapOrElse({});

      for (const dep of deps) {
        const packageName = dep.packageName;
        if (packageName && packageName in lockFileMapping) {
          dep.lockedVersion = lockFileMapping[packageName];
        }
      }
    }

    return Promise.resolve(deps);
  }

  async updateArtifacts(
    updateArtifact: UpdateArtifact,
    project: PyProject,
  ): Promise<UpdateArtifactsResult[] | null> {
    const { config, updatedDeps, packageFileName } = updateArtifact;

    const isLockFileMaintenance =
      config.updateType == 'lockFileMaintenance' ||
      updatedDeps.some((dep) => dep.updateType === 'lockFileMaintenance');

    // abort if no lockfile is defined
    const lockFileName = getSiblingFileName(packageFileName, 'uv.lock');
    try {
      const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
      if (is.nullOrUndefined(existingLockFileContent)) {
        logger.debug('No uv.lock found');
        return null;
      }

      const pythonConstraint: ToolConstraint = {
        toolName: 'python',
        constraint:
          config.constraints?.python ?? project.project?.['requires-python'],
      };
      const uvConstraint: ToolConstraint = {
        toolName: 'uv',
        constraint: config.constraints?.uv,
      };

      const execOptions: ExecOptions = {
        cwdFile: packageFileName,
        docker: {},
        userConfiguredEnv: config.env,
        toolConstraints: [pythonConstraint, uvConstraint],
      };

      // on lockFileMaintenance do not specify any packages and update the complete lock file
      // else only update specific packages
      const cmds: string[] = [];
      if (isLockFileMaintenance) {
        cmds.push(`${uvUpdateCMD} --upgrade`);
      } else {
        cmds.push(generateCMDs(updatedDeps));
      }
      await exec(cmds, execOptions);

      // check for changes
      const fileChanges: UpdateArtifactsResult[] = [];
      const newLockContent = await readLocalFile(lockFileName, 'utf8');
      const isLockFileChanged = existingLockFileContent !== newLockContent;
      if (isLockFileChanged) {
        fileChanges.push({
          file: {
            type: 'addition',
            path: lockFileName,
            contents: newLockContent,
          },
        });
      } else {
        logger.debug('uv.lock is unchanged');
      }

      return fileChanges.length ? fileChanges : null;
    } catch (err) {
      // istanbul ignore if
      if (err.message === TEMPORARY_ERROR) {
        throw err;
      }
      logger.debug({ err }, 'Failed to update uv lock file');
      return [
        {
          artifactError: {
            lockFile: lockFileName,
            stderr: err.message,
          },
        },
      ];
    }
  }
}

function generateCMDs(updatedDeps: Upgrade[]): string {
  let cmd = uvUpdateCMD;
  const listedPackages: string[] = [];
  for (const dep of updatedDeps) {
    if (!(dep.packageName! in listedPackages)) {
      listedPackages.push(dep.packageName!);
      cmd += ` --upgrade-package ${quote(dep.packageName!)}`;
    }
  }
  return cmd;
}
